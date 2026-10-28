/**
 * Orchestrator: queries every provider in parallel, dedups as results arrive
 * and emits events. Always ends with `done`, at the latest when the deadline
 * passes, whatever the providers do.
 */
import { Deduper } from "./dedup.ts";
import type { Send } from "./sse.ts";
import {
  PartialResultError,
  type ProviderAdapter,
  ProviderError,
  type ProviderHotel,
  type ProviderId,
  type ProviderStatus,
  type SearchParams,
} from "./types.ts";

/** A provider's final state, as reported in provider_status and done. */
export interface ProviderOutcome {
  status: Exclude<ProviderStatus, "retrying">;
  /** Hotels the provider returned (before dedup). */
  hotels: number;
  ms: number;
  /** For partial: why it stopped ("timeout" or "error"). */
  reason?: "timeout" | "error";
  message?: string;
}

export interface DoneEvent {
  durationMs: number;
  /** Time to the first hotel event; null if no hotel arrived. */
  firstHotelMs: number | null;
  hotels: number;
  complete: boolean;
  /** Providers that did not finish ok. */
  missing: ProviderId[];
  providers: Partial<Record<ProviderId, ProviderOutcome>>;
}

export interface RunOptions {
  deadlineMs: number;
  /** Aborts the search early (e.g. the client disconnected). */
  signal: AbortSignal;
}

/** After the deadline, how long we wait for adapters to notice the abort before sending done anyway. */
const ABORT_GRACE_MS = 100;

export async function runSearch(params: SearchParams, providers: ProviderAdapter[], send: Send, opts: RunOptions): Promise<DoneEvent> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const deadline = AbortSignal.timeout(opts.deadlineMs);
  const signal = AbortSignal.any([deadline, opts.signal]);

  send("search_started", { params, providers: providers.map((p) => p.id), deadlineMs: opts.deadlineMs });

  const deduper = new Deduper();
  const outcomes: Partial<Record<ProviderId, ProviderOutcome>> = {};
  let firstHotelMs: number | null = null;
  let finished = false;

  const emitHotels = (hotels: ProviderHotel[]) => {
    for (const event of deduper.add(hotels)) {
      if (event.type === "hotel") {
        firstHotelMs ??= elapsed();
        send("hotel", event.hotel);
      } else {
        send("offer", { hotelId: event.hotelId, provider: event.provider, offers: event.offers });
      }
    }
  };

  const settle = (provider: ProviderId, outcome: ProviderOutcome) => {
    if (finished || outcomes[provider]) return;
    outcomes[provider] = outcome;
    send("provider_status", { provider, ...outcome });
  };

  const runs = providers.map(async (p) => {
    try {
      const hotels = await p.search(params, {
        signal,
        onRetry: ({ attempt, reason }) => {
          if (!finished && !outcomes[p.id]) send("provider_status", { provider: p.id, status: "retrying", attempt, reason });
        },
      });
      if (finished) return;
      emitHotels(hotels);
      settle(p.id, { status: "ok", hotels: hotels.length, ms: elapsed() });
    } catch (err) {
      if (finished) return;
      if (err instanceof PartialResultError) {
        emitHotels(err.hotels);
        settle(p.id, {
          status: "partial",
          hotels: err.hotels.length,
          ms: elapsed(),
          reason: deadline.aborted ? "timeout" : "error",
          message: messageOf(err.cause),
        });
      } else {
        settle(p.id, { status: failureStatus(err, deadline), hotels: 0, ms: elapsed(), message: messageOf(err) });
      }
    }
  });

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, opts.deadlineMs + ABORT_GRACE_MS);
  });
  await Promise.race([Promise.allSettled(runs), hardStop]);
  clearTimeout(graceTimer);

  // An adapter that ignored the abort: report it as timed out.
  for (const p of providers) settle(p.id, { status: "timeout", hotels: 0, ms: elapsed(), message: "no answer before the deadline" });
  finished = true;

  const missing = providers.map((p) => p.id).filter((id) => outcomes[id]?.status !== "ok");
  const done: DoneEvent = {
    durationMs: elapsed(),
    firstHotelMs,
    hotels: deduper.hotels().length,
    complete: missing.length === 0,
    missing,
    providers: outcomes,
  };
  send("done", done);
  return done;
}

function failureStatus(err: unknown, deadline: AbortSignal): ProviderOutcome["status"] {
  if (err instanceof ProviderError) return err.status;
  return deadline.aborted ? "timeout" : "error";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
