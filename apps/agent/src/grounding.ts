/**
 * Checks, in code, that an answer only mentions hotels and prices from the
 * last search result, and that it says which providers are missing.
 * It is a heuristic over free text (see DESIGN.md for what it misses).
 */
import type { SearchResult } from "./searchTool.ts";

export interface GroundingReport {
  ok: boolean;
  /** Amounts in USD that match no offer of the last result. */
  unknownPrices: string[];
  /** Hotel-looking names that match no hotel of the last result. */
  unknownHotels: string[];
  /** Missing providers the answer does not mention. */
  unmentionedMissing: string[];
}

const TYPE_WORDS = new Set([
  "hotel", "apart", "cabanas", "lodge", "hosteria", "hostal", "hostel", "posada", "pousada",
  "resort", "spa", "suites", "flat", "beach", "club", "boutique", "wine", "grand",
]);
const ABBREVIATIONS: Record<string, string> = {
  cab: "cabanas", apt: "apart", htl: "hotel", btq: "boutique", rst: "resort", host: "hosteria",
  ldg: "lodge", pos: "posada", pous: "pousada", hstl: "hostel", stes: "suites", bch: "beach",
};
/** Lowercase words allowed inside a name ("Chacras de Coria", "Barra da Lagoa"). */
const JOINERS = new Set(["de", "del", "la", "las", "los", "da", "das", "do", "dos", "&"]);
/** Capitalized at the start of a sentence, but not part of a name ("El Hotel Catedral"). */
const LEADING = new Set(["el", "la", "los", "las", "un", "una", "en", "al", "del", "the", "a", "an", "in", "at"]);

export function checkGrounding(text: string, result: SearchResult | null): GroundingReport {
  const prices = result ? result.hotels.flatMap((h) => h.offers.map((o) => o.priceUsd)) : [];
  const unknownPrices = mentionedPrices(text)
    .filter(({ value }) => !prices.some((p) => Math.abs(p - value) < 0.01 || Math.round(p) === value || Math.floor(p) === value))
    .map(({ raw }) => raw);

  const known = result ? result.hotels.map((h) => tokens(h.name)) : [];
  const unknownHotels = mentionedHotels(text).filter((m) => {
    const core = tokens(m).filter((w) => !TYPE_WORDS.has(w) && !JOINERS.has(w));
    return !known.some((k) => core.every((w) => k.includes(w)));
  });

  const unmentionedMissing = (result?.missing ?? []).filter((id) => !mentionsProvider(text, id));

  return {
    ok: unknownPrices.length === 0 && unknownHotels.length === 0 && unmentionedMissing.length === 0,
    unknownPrices,
    unknownHotels,
    unmentionedMissing,
  };
}

/** Amounts written with a USD marker before or after: "USD 766,10", "US$ 1.570", "$766.10", "766 dólares". */
export function mentionedPrices(text: string): { raw: string; value: number }[] {
  const amount = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
  const re = new RegExp(String.raw`(?:USD|U\$S|US\$|\$)\s?(${amount})|(${amount})\s?(?:USD|dólares|dolares|dollars)`, "gi");
  return [...text.matchAll(re)].map((m) => ({ raw: m[0].trim(), value: parseAmount((m[1] ?? m[2])!) }));
}

/** "1.234,56", "1,234.56", "766,10", "1.570" (thousands), "766". */
function parseAmount(s: string): number {
  const clean = s.replace(/\s/g, "");
  const lastSep = Math.max(clean.lastIndexOf("."), clean.lastIndexOf(","));
  if (lastSep < 0) return Number(clean);
  const decimals = clean.length - lastSep - 1;
  if (decimals === 3) return Number(clean.replace(/[.,]/g, "")); // separator is thousands
  return Number(`${clean.slice(0, lastSep).replace(/[.,]/g, "")}.${clean.slice(lastSep + 1)}`);
}

/** Runs of capitalized words that include a hotel type word and at least one other word. */
export function mentionedHotels(text: string): string[] {
  const found: string[] = [];
  // A name never crosses punctuation: "Hotel Catedral, Lodge Campanario" are two names.
  for (const segment of text.split(/[,;:()*"“”«»!?¿¡\n|]|\.(?=\s|$)|\s[-–—]\s/)) {
    let run: string[] = [];
    const flush = () => {
      while (run.length && LEADING.has(run[0]!.toLowerCase())) run.shift();
      while (run.length && JOINERS.has(run[run.length - 1]!.toLowerCase())) run.pop();
      const t = tokens(run.join(" "));
      if (t.some((w) => TYPE_WORDS.has(w)) && t.some((w) => !TYPE_WORDS.has(w) && !JOINERS.has(w))) found.push(run.join(" "));
      run = [];
    };
    for (const w of segment.split(/\s+/).filter(Boolean)) {
      if (/^\p{Lu}/u.test(w) || (run.length > 0 && JOINERS.has(w.toLowerCase()))) run.push(w);
      else flush();
    }
    flush();
  }
  return found;
}

function tokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w);
}

/** "proveedor B", "B no respondió", "B respondió en parte", "provider B", "(B)". */
function mentionsProvider(text: string, id: string): boolean {
  // Case-sensitive on purpose: the Spanish word "a" must not count as provider A.
  const near = String.raw`[^.\n]{0,60}`;
  return new RegExp(
    String.raw`([Pp]roveedor(es)?|[Pp]rovider(s)?)${near}\b${id}\b|\b${id}\b${near}(respond|contest|incomplet|parte|falt|tiempo|ca[ií]d|error|l[ií]mite|answer|missing|partial|time)|\(${id}\)`,
  ).test(text);
}
