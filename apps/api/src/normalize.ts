/**
 * Pure helpers to compare hotels across providers: names, addresses and
 * coordinates. Dedup decides what to do with the comparisons.
 */
import { type Coords, DESTINATIONS, type ProviderHotel } from "./types.ts";

/** C truncates names to this many characters. */
const C_NAME_MAX = 24;

/** C's abbreviations (some, like BCH CLUB, span two words; each word expands on its own). */
const ABBREVIATIONS: Record<string, string> = {
  cab: "cabanas",
  apt: "apart",
  htl: "hotel",
  btq: "boutique",
  rst: "resort",
  host: "hosteria",
  ldg: "lodge",
  pos: "posada",
  pous: "pousada",
  hstl: "hostel",
  stes: "suites",
  bch: "beach",
};

/** B appends " - Bariloche" and the like; only known destinations are stripped. */
const CITY_SUFFIXES = new Set<string>([...DESTINATIONS, "san carlos de bariloche"]);

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Lowercase words without accents, punctuation or city suffix, with C's abbreviations expanded. */
export function nameTokens(name: string): string[] {
  let n = fold(name);
  const suffix = n.match(/^(.*\S)\s+-\s+([^-]+)$/);
  if (suffix && CITY_SUFFIXES.has(suffix[2]!.trim())) n = suffix[1]!;
  return n
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w);
}

/**
 * "exact": same words in any order.
 * "tolerant": one is a C name cut at 24 chars: its last word may be cut and the other may have more words.
 */
export type NameMatch = "exact" | "tolerant" | "none";

export function compareNames(a: Pick<ProviderHotel, "provider" | "name">, b: Pick<ProviderHotel, "provider" | "name">): NameMatch {
  const x = nameTokens(a.name);
  const y = nameTokens(b.name);
  if (sameWords(x, y)) return "exact";
  if (isTruncatedPrefix(a, x, y) || isTruncatedPrefix(b, y, x)) return "tolerant";
  return "none";
}

function sameWords(x: string[], y: string[]): boolean {
  if (x.length !== y.length) return false;
  const sorted = [...y].sort();
  return [...x].sort().every((w, i) => w === sorted[i]);
}

function isTruncatedPrefix(h: Pick<ProviderHotel, "provider" | "name">, words: string[], other: string[]): boolean {
  if (h.provider !== "C" || h.name.length < C_NAME_MAX || words.length === 0) return false;
  const last = words[words.length - 1]!;
  return words.slice(0, -1).every((w) => other.includes(w)) && other.some((w) => w.startsWith(last));
}

export interface Address {
  street: string;
  /** The trailing street number; null if the address has none. */
  number: string | null;
}

export function splitAddress(address: string): Address {
  const words = fold(address)
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "avenida" ? "av" : w === "boulevard" || w === "bulevar" ? "blvd" : w));
  const last = words[words.length - 1];
  if (last && /^\d+$/.test(last)) return { street: words.slice(0, -1).join(" "), number: last };
  return { street: words.join(" "), number: null };
}

/** Great-circle distance in meters. */
export function distanceMeters(a: Coords, b: Coords): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
