/**
 * Common domain model. Adapters translate each provider into these types;
 * nothing outside an adapter knows a provider's own format.
 */

export const DESTINATIONS = ["bariloche", "mendoza", "salta", "florianopolis", "cancun"] as const;
export type Destination = (typeof DESTINATIONS)[number];

export type ProviderId = "A" | "B" | "C";

/** RO room only, BB bed & breakfast, HB half board, FB full board, AI all inclusive. */
export const BOARDS = ["RO", "BB", "HB", "FB", "AI"] as const;
export type Board = (typeof BOARDS)[number];

export interface SearchParams {
  destination: Destination;
  /** YYYY-MM-DD */
  checkIn: string;
  /** YYYY-MM-DD */
  checkOut: string;
  adults: number;
  children: number;
}

export interface Coords {
  lat: number;
  lng: number;
}

export interface Offer {
  provider: ProviderId;
  roomName: string;
  board: Board;
  capacity: number;
  /** null when the provider didn't say. */
  refundable: boolean | null;
  /** Total for the whole stay, taxes included, in USD. */
  totalUsd: number;
}

/** A hotel as one provider returns it, before dedup. */
export interface ProviderHotel {
  provider: ProviderId;
  providerHotelId: string;
  name: string;
  /** null when the provider didn't send it. */
  stars: number | null;
  address: string;
  /** null when the provider has no coordinates (C never does). */
  coords: Coords | null;
  offers: Offer[];
}

/** A hotel after dedup: one entry, offers from every provider that returned it. */
export interface Hotel {
  /** Our own id, stable across searches. */
  id: string;
  name: string;
  stars: number | null;
  address: string;
  coords: Coords | null;
  sources: { provider: ProviderId; providerHotelId: string }[];
  offers: Offer[];
  /** Why a similar-looking hotel was not merged into this one. */
  matchNote?: string;
}

/** "retrying" is interim; the rest are final. "partial": some hotels arrived, then it failed or timed out. */
export type ProviderStatus = "ok" | "partial" | "retrying" | "timeout" | "error" | "rate_limited";

export interface SearchOptions {
  signal: AbortSignal;
  /** Called before each retry, so the caller can report "retrying". `attempt` is the one about to start (2 = first retry). */
  onRetry?: (info: { attempt: number; reason: string }) => void;
}

/** A provider failure the orchestrator can report as a status. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: "error" | "rate_limited",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`provider ${provider}: ${message}`, options);
    this.name = "ProviderError";
  }
}

/** The provider failed midway (e.g. a later page), but these hotels did arrive. */
export class PartialResultError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly hotels: ProviderHotel[],
    cause: unknown,
  ) {
    super(`provider ${provider}: incomplete results (${hotels.length} hotels)`, { cause });
    this.name = "PartialResultError";
  }
}

export interface ProviderAdapter {
  id: ProviderId;
  search(params: SearchParams, opts: SearchOptions): Promise<ProviderHotel[]>;
}
