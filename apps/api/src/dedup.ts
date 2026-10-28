/**
 * Merges the same hotel from different providers as results arrive.
 *
 * Rule, comparing an incoming hotel with each source of a hotel already shown:
 * - Street and number must match, and the name must match.
 * - Exact name (same words): that is enough.
 * - Tolerant name (C truncated at 24 chars): also needs stars or coordinates
 *   present on both sides and matching.
 * - Stars that differ, or coordinates more than 150 m apart, block the merge.
 * - Never merges two hotels of the same provider; if two shown hotels qualify,
 *   it merges with neither. When in doubt, the hotel is shown apart with a matchNote.
 */
import { compareNames, distanceMeters, type NameMatch, splitAddress } from "./normalize.ts";
import type { Hotel, Offer, ProviderHotel, ProviderId } from "./types.ts";

const MAX_DISTANCE_M = 150;

export type DedupEvent =
  | { type: "hotel"; hotel: Hotel }
  | { type: "offer"; hotelId: string; provider: ProviderId; offers: Offer[] };

interface Comparison {
  name: NameMatch;
  sameAddress: boolean;
  /** null when one side has no stars. */
  stars: boolean | null;
  /** Distance in meters; null when one side has no coordinates. */
  distance: number | null;
}

export function compare(a: ProviderHotel, b: ProviderHotel): Comparison {
  const x = splitAddress(a.address);
  const y = splitAddress(b.address);
  return {
    name: compareNames(a, b),
    sameAddress: x.number !== null && x.street === y.street && x.number === y.number,
    stars: a.stars !== null && b.stars !== null ? a.stars === b.stars : null,
    distance: a.coords && b.coords ? distanceMeters(a.coords, b.coords) : null,
  };
}

const contradicts = (c: Comparison) => c.stars === false || (c.distance !== null && c.distance > MAX_DISTANCE_M);
const reinforced = (c: Comparison) => c.stars === true || (c.distance !== null && c.distance <= MAX_DISTANCE_M);
const sameCore = (c: Comparison) => c.name !== "none" && c.sameAddress;
const passes = (c: Comparison) => sameCore(c) && !contradicts(c) && (c.name === "exact" || reinforced(c));

interface Entry {
  hotel: Hotel;
  sources: ProviderHotel[];
}

export class Deduper {
  private entries: Entry[] = [];

  /** Adds one provider's hotels; returns the events to stream, in order. */
  add(hotels: ProviderHotel[]): DedupEvent[] {
    return hotels.map((h) => this.addOne(h));
  }

  hotels(): Hotel[] {
    return this.entries.map((e) => e.hotel);
  }

  private addOne(incoming: ProviderHotel): DedupEvent {
    const candidates = this.entries
      .filter((e) => !e.sources.some((s) => s.provider === incoming.provider))
      .map((entry) => ({ entry, comparisons: entry.sources.map((s) => compare(incoming, s)) }));

    const matches = candidates.filter(({ comparisons }) => comparisons.some(passes) && !comparisons.some(contradicts));
    if (matches.length === 1) {
      const { entry } = matches[0]!;
      entry.sources.push(incoming);
      entry.hotel.sources.push({ provider: incoming.provider, providerHotelId: incoming.providerHotelId });
      entry.hotel.offers.push(...incoming.offers);
      return { type: "offer", hotelId: entry.hotel.id, provider: incoming.provider, offers: incoming.offers };
    }

    const hotel: Hotel = {
      id: `${incoming.provider}-${incoming.providerHotelId}`,
      name: incoming.name,
      stars: incoming.stars,
      address: incoming.address,
      coords: incoming.coords,
      sources: [{ provider: incoming.provider, providerHotelId: incoming.providerHotelId }],
      offers: [...incoming.offers],
    };
    const note = matches.length > 1 ? tieNote(matches.map((m) => m.entry.hotel)) : nearMissNote(candidates);
    if (note) hotel.matchNote = note;
    this.entries.push({ hotel, sources: [incoming] });
    return { type: "hotel", hotel: structuredClone(hotel) };
  }
}

const label = (h: Hotel) => `«${h.name}» (${h.id})`;

function tieNote(hotels: Hotel[]): string {
  return `Coincide con varios hoteles ya mostrados (${hotels.map(label).join(", ")}); no se unió con ninguno para no elegir mal.`;
}

/** Explains the closest hotel it was not merged with, if any. */
function nearMissNote(candidates: { entry: Entry; comparisons: Comparison[] }[]): string | undefined {
  for (const { entry, comparisons } of candidates) {
    const c = comparisons.find((c) => sameCore(c) && contradicts(c));
    if (c) return `Mismo nombre y dirección que ${label(entry.hotel)}, pero ${contradiction(c)}; se muestra aparte.`;
  }
  for (const { entry, comparisons } of candidates) {
    if (comparisons.some(sameCore)) {
      return `Nombre parecido y misma dirección que ${label(entry.hotel)}, pero no hay estrellas ni coordenadas para confirmarlo; se muestra aparte.`;
    }
  }
  for (const { entry, comparisons } of candidates) {
    if (comparisons.some((c) => c.sameAddress && c.name === "none")) {
      return `Misma dirección que ${label(entry.hotel)} con otro nombre; se muestra aparte.`;
    }
  }
  return undefined;
}

function contradiction(c: Comparison): string {
  if (c.stars === false) return "las estrellas no coinciden";
  return `las coordenadas están a ${Math.round(c.distance ?? 0)} m`;
}
