/**
 * The search_hotels tool: calls our /search API over HTTP, reads the SSE
 * stream as it arrives (reporting progress) and gives the model a compact
 * result. Never talks to the providers directly.
 */
import type { FunctionDeclaration } from "./llm.ts";

export const DESTINATIONS = ["bariloche", "mendoza", "salta", "florianopolis", "cancun"] as const;

export const searchHotelsDeclaration: FunctionDeclaration = {
  name: "search_hotels",
  description:
    "Busca hoteles disponibles en todos los proveedores. Devuelve hoteles con precio total de la estadía en USD (impuestos incluidos), régimen, habitación, si es reembolsable, y el estado de cada proveedor.",
  parameters: {
    type: "object",
    properties: {
      destination: { type: "string", enum: [...DESTINATIONS], description: "Destino, en minúsculas y sin tildes." },
      checkIn: { type: "string", description: "Fecha de entrada, YYYY-MM-DD." },
      checkOut: { type: "string", description: "Fecha de salida, YYYY-MM-DD." },
      adults: { type: "integer", description: "Adultos, de 1 a 6." },
      children: { type: "integer", description: "Menores, de 0 a 4." },
    },
    required: ["destination", "checkIn", "checkOut", "adults"],
  },
};

const ROOM_LABEL: Record<string, string> = {
  SGL: "Single",
  DBL: "Doble",
  TWN: "Doble twin",
  TPL: "Triple",
  FAM: "Familiar",
  STE: "Suite",
};

const BOARD_LABEL: Record<string, string> = {
  RO: "solo alojamiento",
  BB: "desayuno",
  HB: "media pensión",
  FB: "pensión completa",
  AI: "todo incluido",
};

/** Offers per hotel given to the model (the cheapest). */
const OFFERS_PER_HOTEL = 3;

export interface CompactOffer {
  priceUsd: number;
  room: string;
  board: string;
  refundable: boolean | null;
  provider: string;
}

export interface CompactHotel {
  id: string;
  name: string;
  stars: number | null;
  matchNote?: string;
  offers: CompactOffer[];
  /** Offers left out (more expensive than the ones listed). */
  moreOffers: number;
}

export interface ProviderSummary {
  status: string;
  hotels: number;
  reason?: string;
}

export interface SearchResult {
  search: { destination: string; checkIn: string; checkOut: string; adults: number; children: number };
  /** The answer came from the API's cache: prices can be up to 90 s old. */
  cached: boolean;
  complete: boolean;
  missing: string[];
  providers: Record<string, ProviderSummary>;
  hotels: CompactHotel[];
}

export type ToolOutcome = { ok: true; result: SearchResult } | { ok: false; error: string };

/** The search API could not be reached: shown to the user as is. */
export class SearchApiError extends Error {
  override name = "SearchApiError";
}

export interface SearchToolOptions {
  apiUrl?: string;
  fetch?: typeof fetch;
  onProgress?: (message: string) => void;
}

// biome-ignore lint/suspicious/noExplicitAny: SSE payloads from our own API, read field by field
type Json = any;

export async function searchHotels(args: Record<string, unknown>, opts: SearchToolOptions = {}): Promise<ToolOutcome> {
  const apiUrl = opts.apiUrl ?? process.env.API_URL ?? "http://localhost:3000";
  const doFetch = opts.fetch ?? fetch;
  const progress = opts.onProgress ?? (() => {});

  const q = new URLSearchParams();
  q.set("destination", String(args.destination ?? "").trim().toLowerCase());
  for (const k of ["checkIn", "checkOut", "adults", "children"] as const) if (args[k] !== undefined) q.set(k, String(args[k]));

  let res: Response;
  try {
    res = await doFetch(`${apiUrl}/search?${q}`, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new SearchApiError(`No pude conectarme con la API de búsqueda en ${apiUrl}. ¿Está corriendo "bun dev"?`);
  }
  if (res.status === 400) {
    const body: Json = await res.json().catch(() => ({}));
    return { ok: false, error: `Búsqueda rechazada: ${body.message ?? "parámetros inválidos"}` };
  }
  if (!res.ok || !res.body) throw new SearchApiError(`La API de búsqueda respondió con un error (${res.status}).`);

  const hotels = new Map<string, Json>();
  let started: Json = {};
  let done: Json | null = null;
  let cheapest = Number.POSITIVE_INFINITY;

  for await (const { event, data } of readSse(res.body)) {
    if (event === "search_started") {
      started = data;
      progress(data.cached ? "Resultado guardado hace menos de 90 s (caché)." : `Buscando en ${data.providers.join(", ")}…`);
    } else if (event === "hotel") {
      hotels.set(data.id, { ...data, offers: [...data.offers] });
      for (const o of data.offers) cheapest = Math.min(cheapest, o.totalUsd);
    } else if (event === "offer") {
      hotels.get(data.hotelId)?.offers.push(...data.offers);
      for (const o of data.offers) cheapest = Math.min(cheapest, o.totalUsd);
    } else if (event === "provider_status") {
      progress(statusLine(data, cheapest));
    } else if (event === "done") {
      done = data;
    }
  }
  if (!done) throw new SearchApiError("La búsqueda se cortó antes de terminar. Volvé a intentar.");

  return { ok: true, result: compact(started, done, [...hotels.values()]) };
}

function compact(started: Json, done: Json, hotels: Json[]): SearchResult {
  const providers: Record<string, ProviderSummary> = {};
  for (const [id, o] of Object.entries(done.providers as Record<string, Json>)) {
    providers[id] = { status: o.status, hotels: o.hotels, ...(o.reason ? { reason: o.reason } : {}) };
  }
  const compactHotels = hotels
    .map((h): CompactHotel => {
      const offers = [...h.offers].sort((a: Json, b: Json) => a.totalUsd - b.totalUsd);
      return {
        id: h.id,
        name: h.name,
        stars: h.stars,
        ...(h.matchNote ? { matchNote: h.matchNote } : {}),
        offers: offers.slice(0, OFFERS_PER_HOTEL).map((o: Json) => ({
          priceUsd: o.totalUsd,
          room: ROOM_LABEL[o.roomType] ?? o.roomName,
          board: BOARD_LABEL[o.board] ?? o.board,
          refundable: o.refundable,
          provider: o.provider,
        })),
        moreOffers: Math.max(0, offers.length - OFFERS_PER_HOTEL),
      };
    })
    .sort((a, b) => (a.offers[0]?.priceUsd ?? 0) - (b.offers[0]?.priceUsd ?? 0));

  const p = started.params ?? {};
  return {
    search: { destination: p.destination, checkIn: p.checkIn, checkOut: p.checkOut, adults: p.adults, children: p.children },
    cached: Boolean(done.cached),
    complete: Boolean(done.complete),
    missing: done.missing ?? [],
    providers,
    hotels: compactHotels,
  };
}

function statusLine(s: Json, cheapest: number): string {
  const from = Number.isFinite(cheapest) ? `; lo más barato hasta ahora: USD ${cheapest.toFixed(2)}` : "";
  switch (s.status) {
    case "ok":
      return `${s.provider}: ${s.hotels} hoteles${from}`;
    case "retrying":
      return `${s.provider}: reintentando`;
    case "partial":
      return `${s.provider}: respondió en parte (${s.hotels} hoteles; ${s.reason === "timeout" ? "se cortó por tiempo" : "falló una página"})`;
    case "timeout":
      return `${s.provider}: no respondió a tiempo`;
    case "rate_limited":
      return `${s.provider}: límite de pedidos alcanzado`;
    default:
      return `${s.provider}: error`;
  }
}

/** Parses an SSE stream into events as they arrive. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Json }> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}
