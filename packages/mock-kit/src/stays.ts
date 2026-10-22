/**
 * Deterministic availability + pricing. Given the same hotel, provider and
 * stay, the answer is always the same, so results are comparable across runs.
 */
import { type Hotel, type ProviderKey, type RoomTemplate, DESTINATIONS, round } from "./catalog.ts";
import { unit } from "./rng.ts";

export interface Stay {
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  adults: number;
  children: number;
}

export interface RoomQuote {
  room: RoomTemplate;
  nights: number;
  /** Net nightly price in USD, before taxes. */
  nightlyNetUsd: number;
  /** Total for the stay in USD, taxes included. */
  totalUsd: number;
  taxesUsd: number;
  refundable: boolean;
}

/** Each provider negotiates different rates for the same room. */
const MARKUP: Record<ProviderKey, number> = { a: 1.0, b: 1.08, c: 0.96, d: 1.02 };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s || !ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Returns an error message, or null when the stay is valid. */
export function validateStay(stay: Stay): string | null {
  if (!parseIsoDate(stay.checkIn) || !parseIsoDate(stay.checkOut)) return "invalid dates";
  const n = nightsBetween(stay.checkIn, stay.checkOut);
  if (n < 1) return "checkOut must be after checkIn";
  if (n > 30) return "stays longer than 30 nights are not supported";
  if (!Number.isInteger(stay.adults) || stay.adults < 1 || stay.adults > 6) return "adults must be 1-6";
  if (!Number.isInteger(stay.children) || stay.children < 0 || stay.children > 4) return "children must be 0-4";
  return null;
}

export function quote(hotel: Hotel, provider: ProviderKey, stay: Stay): RoomQuote[] {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const stayKey = `${stay.checkIn}|${stay.checkOut}`;
  // ~20% of hotels are sold out for any given stay, independently per provider.
  if (unit(hotel.id, provider, stayKey, "open") < 0.2) return [];

  const dest = DESTINATIONS.find((d) => d.key === hotel.destination);
  if (!dest) return [];
  const month = Number(stay.checkIn.slice(5, 7));
  const season = dest.season[month] ?? 1;
  const noise = 0.95 + unit(hotel.id, provider, stayKey, "noise") * 0.1;
  const pax = stay.adults + stay.children;

  return hotel.rooms
    .filter((room) => room.capacity >= pax && unit(hotel.id, provider, stayKey, room.code) < 0.85)
    .map((room) => {
      const nightlyNetUsd = round(hotel.baseNightlyUsd * room.factor * season * noise * MARKUP[provider]);
      const net = nightlyNetUsd * nights;
      const taxesUsd = round(net * dest.taxes.pct + dest.taxes.perNightUsd * nights);
      return {
        room,
        nights,
        nightlyNetUsd,
        totalUsd: round(net + taxesUsd),
        taxesUsd,
        refundable: unit(hotel.id, room.code, "refundable") < 0.65,
      };
    });
}
