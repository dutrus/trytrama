/**
 * Adapter for provider C (LegacyGDS): SOAP-ish XML over POST, nightly NET
 * prices in USD, taxes from HotelTaxRQ (the manual's table is outdated).
 * Errors arrive as HTTP 200 with a <Fault>; only throughput errors use 429.
 * No coordinates. Names come abbreviated and truncated to 24 chars; we keep
 * them as they are (normalizing is not the adapter's job).
 */
import { TtlCache } from "../cache.ts";
import {
  BOARDS,
  type Board,
  type Destination,
  type Offer,
  type ProviderAdapter,
  ProviderError,
  type ProviderHotel,
  type SearchOptions,
  type SearchParams,
} from "../types.ts";

export type TaxTable = Map<string, { pct: number; perNight: number }>;

export interface ProviderCConfig {
  baseUrl: string;
  user: string;
  password: string;
  /** C's limit is per account, so every search shares one limiter. */
  limiter: RateLimiter;
  taxCache: TtlCache<TaxTable>;
}

const IATA: Record<Destination, string> = { bariloche: "BRC", mendoza: "MDZ", salta: "SLA", florianopolis: "FLN", cancun: "CUN" };

const TAX_TTL_MS = 60 * 60 * 1000;
const MAX_429_RETRIES = 2;
const MAX_503_RETRIES = 1;

/** Token bucket: up to `rps` requests per second, bursts of `burst`. */
export class RateLimiter {
  private tokens: number;
  private last = performance.now();

  constructor(
    private readonly rps: number,
    private readonly burst = rps,
  ) {
    this.tokens = burst;
  }

  /** Waits for a slot; rejects if the signal aborts first. */
  async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = performance.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rps);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(((1 - this.tokens) / this.rps) * 1000, signal);
    }
  }
}

// C allows 5 req/s with bursts of 5. Our burst is 4: the first request also
// opens the connection and reaches C later than we counted it, so with a
// burst of 5 the 6th request could arrive slightly early and get a 429.
const sharedLimiter = new RateLimiter(5, 4);
const sharedTaxCache = new TtlCache<TaxTable>();

const defaultConfig = (): ProviderCConfig => ({
  baseUrl: process.env.PROVIDER_C_URL ?? `http://localhost:${process.env.PROVIDER_C_PORT ?? 4003}`,
  user: process.env.PROVIDER_C_USER ?? "trama",
  password: process.env.PROVIDER_C_PASSWORD ?? "demo",
  limiter: sharedLimiter,
  taxCache: sharedTaxCache,
});

export function createProviderC(overrides: Partial<ProviderCConfig> = {}): ProviderAdapter {
  const config = { ...defaultConfig(), ...overrides };

  // Loaded with the first caller's signal; concurrent callers share that load.
  const taxTable = (opts: SearchOptions) =>
    config.taxCache.getOrLoad("taxes", TAX_TTL_MS, async () => parseTaxes(await call(config, "<HotelTaxRQ/>", opts)));

  return {
    id: "C",
    async search(params, opts) {
      const rq =
        `<HotelAvailRQ destination="${IATA[params.destination]}" checkin="${escapeXml(params.checkIn)}" checkout="${escapeXml(params.checkOut)}">` +
        `<Occupancy adults="${params.adults}" children="${params.children}"/></HotelAvailRQ>`;
      const [taxes, xml] = await Promise.all([taxTable(opts), call(config, rq, opts)]);
      const tax = taxes.get(IATA[params.destination]);
      if (!tax) throw new ProviderError("C", "error", `no tax entry for ${IATA[params.destination]}`);
      return parseAvailability(xml, params, tax);
    },
  };
}

/** POSTs one message, handling the rate limit, 429s and GDS-503 faults. Returns the XML. */
async function call(config: ProviderCConfig, inner: string, opts: SearchOptions): Promise<string> {
  const body =
    `<Envelope><Header><Credentials user="${escapeXml(config.user)}" password="${escapeXml(config.password)}"/></Header>` +
    `<Body>${inner}</Body></Envelope>`;
  let attempt = 1;
  let retries429 = 0;
  let retries503 = 0;

  for (;;) {
    await rateLimited(() => config.limiter.acquire(opts.signal), "aborted waiting for a rate-limit slot");
    const res = await fetch(new URL("/gds", config.baseUrl), {
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8" },
      body,
      signal: opts.signal,
    });
    const xml = await res.text();

    if (res.status === 429) {
      if (retries429++ >= MAX_429_RETRIES || opts.signal.aborted) throw new ProviderError("C", "rate_limited", "HTTP 429");
      const waitMs = retryAfterMs(res.headers.get("retry-after"));
      opts.onRetry?.({ attempt: ++attempt, reason: `rate limited, retry after ${waitMs} ms` });
      await rateLimited(() => sleep(waitMs, opts.signal), "aborted waiting for Retry-After");
      continue;
    }

    const fault = parseFault(xml);
    if (fault?.code === "GDS-503" && retries503++ < MAX_503_RETRIES && !opts.signal.aborted) {
      opts.onRetry?.({ attempt: ++attempt, reason: `${fault.code} ${fault.message}` });
      continue;
    }
    if (fault) throw new ProviderError("C", fault.code === "GDS-429" ? "rate_limited" : "error", `${fault.code} ${fault.message}`);
    if (!res.ok) throw new ProviderError("C", "error", `HTTP ${res.status}`);
    return xml;
  }
}

/** A deadline hit while waiting on the rate limit is reported as rate_limited, not timeout. */
async function rateLimited(wait: () => Promise<void>, message: string): Promise<void> {
  try {
    await wait();
  } catch (err) {
    throw new ProviderError("C", "rate_limited", message, { cause: err });
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseAvailability(xml: string, params: SearchParams, tax: { pct: number; perNight: number }): ProviderHotel[] {
  const rs = elements(xml, "HotelAvailRS")[0];
  if (!rs) throw new ProviderError("C", "error", "missing HotelAvailRS");
  if (rs.currency !== "USD") throw new ProviderError("C", "error", `unexpected currency ${rs.currency}`);
  if (rs.checkin !== params.checkIn || rs.checkout !== params.checkOut) {
    throw new ProviderError("C", "error", `answered for other dates: ${rs.checkin} - ${rs.checkout}`);
  }

  const nights = (Date.parse(params.checkOut) - Date.parse(params.checkIn)) / 86_400_000;
  const hotels: ProviderHotel[] = [];
  for (const m of xml.matchAll(/<Property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Property>)/g)) {
    const p = attributes(m[1] ?? "");
    if (!p.code || !p.name) continue;
    const offers = elements(m[2] ?? "", "Rate")
      .map((r) => parseRate(r, nights, tax))
      .filter((o) => o !== null);
    if (offers.length === 0) continue;
    const category = Number(p.category);
    hotels.push({
      provider: "C",
      providerHotelId: p.code,
      name: p.name,
      stars: Number.isInteger(category) && category >= 1 && category <= 5 ? category : null,
      address: p.addr ?? "",
      coords: null,
      offers,
    });
  }
  return hotels;
}

function parseRate(r: Record<string, string>, nights: number, tax: { pct: number; perNight: number }): Offer | null {
  const nightly = Number(r.nightly);
  const capacity = Number(r.maxPax);
  if (!BOARDS.includes(r.plan as Board) || !r.nightly || !(nightly > 0) || !Number.isInteger(capacity)) return null;
  const total = nightly * nights * (1 + tax.pct / 100) + tax.perNight * nights;
  return {
    provider: "C",
    roomName: r.room ?? "",
    board: r.plan as Board,
    capacity,
    refundable: r.refundable === "Y" ? true : r.refundable === "N" ? false : null,
    totalUsd: Math.round(total * 100) / 100,
  };
}

export function parseTaxes(xml: string): TaxTable {
  const table: TaxTable = new Map();
  for (const t of elements(xml, "Tax")) {
    const pct = Number(t.pct);
    const perNight = Number(t.perNight);
    if (!t.destination || t.cur !== "USD" || !t.pct || !t.perNight || !Number.isFinite(pct) || !Number.isFinite(perNight)) {
      throw new ProviderError("C", "error", `bad tax entry ${JSON.stringify(t)}`);
    }
    table.set(t.destination, { pct, perNight });
  }
  if (table.size === 0) throw new ProviderError("C", "error", "empty tax table");
  return table;
}

// --- Minimal XML reading. C's format is flat and attribute-based, so a few
// regexes cover it; no CDATA, comments or namespace prefixes are handled.

/** Attributes of every element named `name`. */
export function elements(xml: string, name: string): Record<string, string>[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b([^>]*?)/?>`, "g"))].map((m) => attributes(m[1] ?? ""));
}

function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

function parseFault(xml: string): { code: string; message: string } | null {
  if (!/<Fault\b/.test(xml)) return null;
  const text = (tag: string) => decodeEntities(xml.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`))?.[1] ?? "").trim();
  return { code: text("Code") || "UNKNOWN", message: text("Message") };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
