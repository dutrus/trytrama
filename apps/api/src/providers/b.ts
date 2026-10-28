/**
 * Adapter for provider B (SurBeds): REST + JSON in Spanish, ARS amounts as
 * "1.234.567,89" strings, DD/MM/YYYY dates, cursor pagination.
 * The manual lies: limite is capped at 20, impuestos_incluidos is often false,
 * categoria can be "Boutique", coordenadas can be null and todo_incluido exists.
 * About 5% of requests never answer, so each request is hedged once.
 */
import { TtlCache } from "../cache.ts";
import {
  type Board,
  type Coords,
  type Destination,
  type Offer,
  PartialResultError,
  type ProviderAdapter,
  ProviderError,
  type ProviderHotel,
  type SearchOptions,
  type SearchParams,
} from "../types.ts";

export interface ProviderBConfig {
  baseUrl: string;
  /** Without an answer after this long, a second identical request is sent. */
  hedgeMs: number;
  /** USD -> ARS rate, valid until the day changes (UTC, like the provider). */
  fxCache: TtlCache<number>;
  /** The rate load is shared between searches, so it has its own timeout instead of a search's signal. */
  fxTimeoutMs: number;
  now: () => number;
}

const CIUDAD_ID: Record<Destination, number> = { bariloche: 1, mendoza: 2, salta: 3, florianopolis: 7, cancun: 12 };

const REGIMEN: Record<string, Board> = {
  solo_alojamiento: "RO",
  desayuno: "BB",
  media_pension: "HB",
  pension_completa: "FB",
  todo_incluido: "AI",
};

const PAGE_LIMIT = 50;
/** Guard against a cursor that never ends. */
const MAX_PAGES = 10;

const sharedFxCache = new TtlCache<number>();

const defaultConfig = (): ProviderBConfig => ({
  baseUrl: process.env.PROVIDER_B_URL ?? `http://localhost:${process.env.PROVIDER_B_PORT ?? 4002}`,
  // B's slowest normal answer is 2.5 s.
  hedgeMs: 2600,
  fxCache: sharedFxCache,
  // Room for a hedge: 2.6 s plus another slow answer.
  fxTimeoutMs: 6000,
  now: Date.now,
});

export function createProviderB(overrides: Partial<ProviderBConfig> = {}): ProviderAdapter {
  const config = { ...defaultConfig(), ...overrides };

  // The load runs on its own timeout; each search only stops waiting on its own signal.
  const usdArsRate = (opts: SearchOptions) =>
    config.fxCache.getOrLoad(
      "usd-ars",
      msUntilNextUtcDay(config.now()),
      async () => {
        const loadOpts = { signal: AbortSignal.timeout(config.fxTimeoutMs), onRetry: opts.onRetry };
        const url = new URL("/api/v2/cotizacion", config.baseUrl);
        const body = await hedged((signal) => getJson(url, signal), config.hedgeMs, loadOpts);
        const rate = parseArs(body.data?.tipo_cambio);
        if (rate === null || rate <= 0) throw new ProviderError("B", "error", `bad exchange rate ${body.data?.tipo_cambio}`);
        return rate;
      },
      opts.signal,
    );

  return {
    id: "B",
    async search(params, opts) {
      const ratePromise = usdArsRate(opts);
      ratePromise.catch(() => {}); // awaited below; avoid an unhandled rejection if a page fails first

      const hotels: ProviderHotel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page === 0 || cursor; page++) {
        try {
          if (page >= MAX_PAGES) throw new ProviderError("B", "error", `more than ${MAX_PAGES} pages`);
          const url = availabilityUrl(config.baseUrl, params, cursor);
          const body = await hedged((signal) => getJson(url, signal), config.hedgeMs, opts);
          checkEcho(body, params);
          hotels.push(...parseHotels(body.data?.hoteles, await ratePromise));
          cursor = typeof body.paginacion?.siguiente_cursor === "string" ? body.paginacion.siguiente_cursor : undefined;
        } catch (err) {
          if (hotels.length > 0) throw new PartialResultError("B", hotels, err);
          throw err;
        }
      }
      return hotels;
    },
  };
}

function availabilityUrl(baseUrl: string, params: SearchParams, cursor: string | undefined): URL {
  const url = new URL("/api/v2/disponibilidad", baseUrl);
  url.searchParams.set("ciudad_id", String(CIUDAD_ID[params.destination]));
  url.searchParams.set("fecha_ingreso", toDmy(params.checkIn));
  url.searchParams.set("fecha_egreso", toDmy(params.checkOut));
  url.searchParams.set("adultos", String(params.adults));
  url.searchParams.set("menores", String(params.children));
  url.searchParams.set("limite", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

// biome-ignore lint/suspicious/noExplicitAny: provider JSON is untrusted; every field is checked below
type Json = any;

async function getJson(url: URL, signal: AbortSignal): Promise<Json> {
  const res = await fetch(url, { signal });
  const body: Json = await res.json().catch(() => null);
  if (!res.ok || body?.estado !== "ok") {
    throw new ProviderError("B", "error", `HTTP ${res.status} ${body?.codigo ?? ""} ${body?.detalle ?? ""}`.trim());
  }
  return body;
}

/**
 * Runs `run`; if it hasn't settled after `hedgeMs`, runs it again without
 * cancelling the first, and keeps whichever answers first.
 * A fast failure (before the hedge) is not retried.
 */
export function hedged<T>(run: (signal: AbortSignal) => Promise<T>, hedgeMs: number, opts: SearchOptions): Promise<T> {
  const losers = new AbortController();
  const signal = AbortSignal.any([opts.signal, losers.signal]);
  return new Promise<T>((resolve, reject) => {
    let running = 0;
    const launch = () => {
      running++;
      run(signal).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
          losers.abort();
        },
        (err) => {
          if (--running > 0) return;
          clearTimeout(timer);
          reject(err);
        },
      );
    };
    const timer = setTimeout(() => {
      if (opts.signal.aborted) return;
      opts.onRetry?.({ attempt: 2, reason: `no response after ${hedgeMs} ms` });
      launch();
    }, hedgeMs);
    launch();
  });
}

function checkEcho(body: Json, params: SearchParams): void {
  const b = body.data?.busqueda;
  if (b?.fecha_ingreso !== toDmy(params.checkIn) || b?.fecha_egreso !== toDmy(params.checkOut)) {
    throw new ProviderError("B", "error", `answered for other dates: ${b?.fecha_ingreso} - ${b?.fecha_egreso}`);
  }
}

export function parseHotels(hoteles: Json, usdArs: number): ProviderHotel[] {
  if (!Array.isArray(hoteles)) throw new ProviderError("B", "error", "missing hoteles");
  const hotels: ProviderHotel[] = [];
  for (const h of hoteles as Json[]) {
    if (typeof h?.id_hotel !== "number" || typeof h.nombre !== "string") continue;
    const offers = (Array.isArray(h.habitaciones) ? h.habitaciones : [])
      .map((r: Json) => parseRoom(r, usdArs))
      .filter((o: Offer | null) => o !== null);
    if (offers.length === 0) continue;
    hotels.push({
      provider: "B",
      providerHotelId: String(h.id_hotel),
      name: h.nombre,
      stars: parseStars(h.categoria),
      address: typeof h.ubicacion?.direccion === "string" ? h.ubicacion.direccion : "",
      coords: parseCoords(h.ubicacion?.coordenadas),
      offers,
    });
  }
  return hotels;
}

function parseRoom(r: Json, usdArs: number): Offer | null {
  const board = REGIMEN[r?.regimen];
  const tarifa = r?.tarifa;
  if (!board || tarifa?.moneda !== "ARS" || !Number.isInteger(r.capacidad_max)) return null;

  let totalArs = parseArs(tarifa.precio_total);
  if (totalArs === null || typeof tarifa.impuestos_incluidos !== "boolean") return null;
  if (!tarifa.impuestos_incluidos) {
    const taxes = parseArs(tarifa.impuestos);
    if (taxes === null) return null;
    totalArs += taxes;
  }

  return {
    provider: "B",
    roomName: typeof r.descripcion === "string" ? r.descripcion : String(r.codigo_habitacion ?? ""),
    board,
    capacity: r.capacidad_max,
    refundable: tarifa.politica === "reembolsable" ? true : tarifa.politica === "no_reembolsable" ? false : null,
    totalUsd: Math.round((totalArs / usdArs) * 100) / 100,
  };
}

/** "1.234.567,89" -> 1234567.89; anything else -> null. */
export function parseArs(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d{1,3}(\.\d{3})*,\d{2}$/.test(s)) return null;
  return Number(s.replaceAll(".", "").replace(",", "."));
}

/** "4*" or "4 estrellas" -> 4; "Boutique" or anything else -> null. */
export function parseStars(categoria: unknown): number | null {
  const m = typeof categoria === "string" ? categoria.trim().match(/^([1-5])\s*(\*|estrellas?)$/i) : null;
  return m ? Number(m[1]) : null;
}

function parseCoords(c: Json): Coords | null {
  const lat = Number.parseFloat(c?.lat);
  const lng = Number.parseFloat(c?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** YYYY-MM-DD -> DD/MM/YYYY */
function toDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function msUntilNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}
