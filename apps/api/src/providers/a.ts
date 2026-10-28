/**
 * Adapter for provider A (Andes Wholesale): REST + JSON, prices already in USD
 * and for the whole stay. We assume taxes are included (see DESIGN.md).
 * starRating, refundable and geo can be missing even though the manual says otherwise.
 */
import {
  BOARDS,
  type Board,
  type Coords,
  type Offer,
  type ProviderAdapter,
  type ProviderHotel,
  type SearchOptions,
} from "../types.ts";

export interface ProviderAConfig {
  baseUrl: string;
  apiKey: string;
}

/** One retry on a 5xx. */
const MAX_ATTEMPTS = 2;

const defaultConfig = (): ProviderAConfig => ({
  baseUrl: process.env.PROVIDER_A_URL ?? `http://localhost:${process.env.PROVIDER_A_PORT ?? 4001}`,
  apiKey: process.env.PROVIDER_A_KEY ?? "trama",
});

export function createProviderA(config: ProviderAConfig = defaultConfig()): ProviderAdapter {
  return {
    id: "A",
    async search(params, opts) {
      const url = new URL("/v1/availability", config.baseUrl);
      url.searchParams.set("destination", params.destination);
      url.searchParams.set("checkIn", params.checkIn);
      url.searchParams.set("checkOut", params.checkOut);
      url.searchParams.set("adults", String(params.adults));
      url.searchParams.set("children", String(params.children));
      return parseAvailability(await fetchWithRetry(url, config.apiKey, opts));
    },
  };
}

async function fetchWithRetry(url: URL, apiKey: string, opts: SearchOptions): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: opts.signal });
    if (res.ok) return res.json();

    await res.body?.cancel();
    const reason = `HTTP ${res.status}`;
    if (res.status < 500 || attempt >= MAX_ATTEMPTS) throw new Error(`provider A: ${reason}`);
    if (opts.signal.aborted) throw opts.signal.reason;
    opts.onRetry?.({ attempt: attempt + 1, reason });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: provider JSON is untrusted; every field is checked below
type Json = any;

export function parseAvailability(body: Json): ProviderHotel[] {
  if (body?.currency !== "USD") throw new Error(`provider A: unexpected currency ${body?.currency}`);
  if (!Array.isArray(body.hotels)) throw new Error("provider A: missing hotels");

  const hotels: ProviderHotel[] = [];
  for (const h of body.hotels as Json[]) {
    if (typeof h?.hotelId !== "string" || typeof h.name !== "string") continue;
    const offers = (Array.isArray(h.rooms) ? h.rooms : []).map(parseRoom).filter((o: Offer | null) => o !== null);
    if (offers.length === 0) continue;
    hotels.push({
      provider: "A",
      providerHotelId: h.hotelId,
      name: h.name,
      stars: Number.isInteger(h.starRating) && h.starRating >= 1 && h.starRating <= 5 ? h.starRating : null,
      address: typeof h.address === "string" ? h.address : "",
      coords: parseGeo(h.geo),
      offers,
    });
  }
  return hotels;
}

function parseRoom(r: Json): Offer | null {
  if (!BOARDS.includes(r?.boardType)) return null;
  if (typeof r.totalPrice !== "number" || !Number.isFinite(r.totalPrice) || r.totalPrice <= 0) return null;
  if (!Number.isInteger(r.maxOccupancy)) return null;
  return {
    provider: "A",
    roomName: typeof r.roomName === "string" ? r.roomName : String(r.roomCode ?? ""),
    board: r.boardType as Board,
    capacity: r.maxOccupancy,
    refundable: typeof r.refundable === "boolean" ? r.refundable : null,
    totalUsd: r.totalPrice,
  };
}

function parseGeo(geo: Json): Coords | null {
  return Number.isFinite(geo?.lat) && Number.isFinite(geo?.lng) ? { lat: geo.lat, lng: geo.lng } : null;
}
