/**
 * Orchestrator with fake adapters: no HTTP, each fake decides when and how it answers.
 */
import { describe, expect, test } from "bun:test";
import { runSearch } from "./search.ts";
import {
  PartialResultError,
  type ProviderAdapter,
  ProviderError,
  type ProviderHotel,
  type ProviderId,
  type SearchOptions,
  type SearchParams,
} from "./types.ts";

const params: SearchParams = { destination: "bariloche", checkIn: "2026-12-01", checkOut: "2026-12-05", adults: 2, children: 0 };

function hotel(provider: ProviderId, id: string, name: string, address: string, stars: number | null = 4): ProviderHotel {
  return {
    provider,
    providerHotelId: id,
    name,
    stars,
    address,
    coords: null,
    offers: [{ provider, roomName: "DBL", board: "BB", capacity: 2, refundable: true, totalUsd: 100 }],
  };
}

const fake = (id: ProviderId, search: (opts: SearchOptions) => Promise<ProviderHotel[]>): ProviderAdapter => ({
  id,
  search: (_params, opts) => search(opts),
});

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
const after = <T>(ms: number, value: T, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

async function run(providers: ProviderAdapter[], deadlineMs = 300, signal = new AbortController().signal) {
  // biome-ignore lint/suspicious/noExplicitAny: event payloads differ per event name
  const events: { event: string; data: any }[] = [];
  const done = await runSearch(params, providers, (event, data) => events.push({ event, data }), { deadlineMs, signal });
  return { events, done, names: events.map((e) => e.event) };
}

const cerroOttoA = hotel("A", "AW-1", "Cabañas Cerro Otto", "Elflein 1597");
const cerroOttoC = hotel("C", "BRC1", "CAB CERRO OTTO", "ELFLEIN 1597");
const catedralB = hotel("B", "80001", "Hotel Catedral", "Av. Bustillo 1744");

describe("runSearch", () => {
  test("streams search_started first, then results as each provider answers, then done", async () => {
    const { events, names, done } = await run([
      fake("A", (o) => after(10, [cerroOttoA], o.signal)),
      fake("B", (o) => after(40, [catedralB], o.signal)),
      fake("C", (o) => after(70, [cerroOttoC], o.signal)),
    ]);
    expect(names).toEqual(["search_started", "hotel", "provider_status", "hotel", "provider_status", "offer", "provider_status", "done"]);
    expect(events[0]!.data).toEqual({ params, providers: ["A", "B", "C"], deadlineMs: 300, cached: false });
    expect(events[5]!.data).toMatchObject({ hotelId: "A-AW-1", provider: "C" });
    expect(done).toMatchObject({ hotels: 2, complete: true, missing: [] });
    expect(done.providers.A).toMatchObject({ status: "ok", hotels: 1 });
    expect(done.firstHotelMs).toBeGreaterThanOrEqual(5);
    expect(done.firstHotelMs!).toBeLessThan(40);
    expect(events.at(-1)!.data).toEqual(done);
  });

  test("a slow provider times out and done still arrives at the deadline", async () => {
    const t0 = performance.now();
    const { done, events } = await run(
      [fake("A", (o) => after(10, [cerroOttoA], o.signal)), fake("C", (o) => after(10_000, [cerroOttoC], o.signal))],
      150,
    );
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(400);
    expect(done).toMatchObject({ complete: false, missing: ["C"], hotels: 1 });
    expect(done.providers.C).toMatchObject({ status: "timeout", hotels: 0 });
    expect(events.filter((e) => e.event === "provider_status").map((e) => e.data.provider)).toEqual(["A", "C"]);
  });

  test("an adapter that ignores the abort cannot hold done back", async () => {
    const { done } = await run([fake("B", () => new Promise(() => {}))], 100);
    expect(done.providers.B).toMatchObject({ status: "timeout", message: "no answer before the deadline" });
  });

  test("a late answer after done is ignored", async () => {
    let resolveLate!: (h: ProviderHotel[]) => void;
    const { events } = await run([fake("B", () => new Promise((r) => (resolveLate = r)))], 50);
    const count = events.length;
    resolveLate([catedralB]);
    await Bun.sleep(5);
    expect(events).toHaveLength(count);
    expect(events.at(-1)!.event).toBe("done");
  });

  test("partial: the hotels that arrived are shown, with the reason and how many", async () => {
    const { events, done } = await run([
      fake("B", async (o) => {
        await new Promise((r) => o.signal.addEventListener("abort", r));
        throw new PartialResultError("B", [catedralB], o.signal.reason);
      }),
      fake("C", async () => {
        throw new PartialResultError("C", [cerroOttoC], new ProviderError("C", "error", "HTTP 400 CURSOR_INVALIDO"));
      }),
    ], 100);
    expect(events.filter((e) => e.event === "hotel")).toHaveLength(2);
    expect(done.providers.B).toMatchObject({ status: "partial", hotels: 1, reason: "timeout" });
    expect(done.providers.C).toMatchObject({ status: "partial", hotels: 1, reason: "error", message: "provider C: HTTP 400 CURSOR_INVALIDO" });
    expect(done.missing).toEqual(["B", "C"]);
  });

  test("retries are reported as retrying before the final status", async () => {
    const { events } = await run([
      fake("B", async (o) => {
        o.onRetry?.({ attempt: 2, reason: "no response after 2600 ms" });
        return [catedralB];
      }),
    ]);
    const statuses = events.filter((e) => e.event === "provider_status").map((e) => e.data);
    expect(statuses).toEqual([
      { provider: "B", status: "retrying", attempt: 2, reason: "no response after 2600 ms" },
      expect.objectContaining({ provider: "B", status: "ok", hotels: 1 }),
    ]);
  });

  test("rate_limited and error statuses come from the adapter's error", async () => {
    const { done } = await run([
      fake("A", async () => {
        throw new Error("provider A: HTTP 500");
      }),
      fake("C", async () => {
        throw new ProviderError("C", "rate_limited", "HTTP 429");
      }),
    ]);
    expect(done.providers.A).toMatchObject({ status: "error", message: "provider A: HTTP 500" });
    expect(done.providers.C).toMatchObject({ status: "rate_limited" });
  });

  test("a client that goes away aborts the providers' signal", async () => {
    const client = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = run(
      [
        fake("B", (o) => {
          seen = o.signal;
          return after(10_000, [], o.signal);
        }),
      ],
      5_000,
      client.signal,
    );
    await Bun.sleep(10);
    client.abort(new Error("client disconnected"));
    const { done } = await pending;
    expect(seen?.aborted).toBe(true);
    expect(done.providers.B?.status).toBe("error");
  });
});
