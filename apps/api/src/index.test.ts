import { describe, expect, test } from "bun:test";
import { TtlCache } from "./cache.ts";
import { createApp, parseSearchParams } from "./index.ts";
import type { ProviderAdapter, ProviderHotel } from "./types.ts";

const hotelA: ProviderHotel = {
  provider: "A",
  providerHotelId: "AW-1",
  name: "Cabañas Cerro Otto",
  stars: 4,
  address: "Elflein 1597",
  coords: null,
  offers: [{ provider: "A", roomName: "Twin", board: "BB", capacity: 2, refundable: true, totalUsd: 766.1 }],
};

const fakeA: ProviderAdapter = { id: "A", search: async () => [hotelA] };
const app = createApp({ providers: [fakeA], deadlineMs: 200 });
const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));
const ok = "destination=bariloche&checkIn=2026-12-01&checkOut=2026-12-05&adults=2";

describe("GET /search", () => {
  test("streams SSE that starts with search_started and ends with done", async () => {
    const res = get(`/search?${ok}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const names = [...(await res.text()).matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(["search_started", "hotel", "provider_status", "done"]);
  });

  test("invalid parameters get a 400 in JSON, not a stream", async () => {
    const res = get("/search?destination=paris&checkIn=2026-12-01&checkOut=2026-12-05&adults=2");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: "invalid_params" });
  });

  test("health and unknown routes", async () => {
    expect(await get("/health").json()).toEqual({ ok: true });
    expect(get("/nope").status).toBe(404);
  });
});

describe("search cache", () => {
  /** Parses an SSE body into events. */
  const read = async (res: Response) =>
    (await res.text())
      .trim()
      .split("\n\n")
      .map((block) => ({ event: block.match(/^event: (.*)$/m)![1]!, data: JSON.parse(block.match(/^data: (.*)$/m)![1]!) }));

  function setup(failB = false) {
    let now = 0;
    const calls = { A: 0, B: 0 };
    const providers: ProviderAdapter[] = [
      {
        id: "A",
        search: async (_p, o) => {
          calls.A++;
          o.onRetry?.({ attempt: 2, reason: "HTTP 500" });
          return [hotelA];
        },
      },
      {
        id: "B",
        search: async () => {
          calls.B++;
          if (failB) throw new Error("provider B: HTTP 400");
          return [];
        },
      },
    ];
    const cached = createApp({ providers, deadlineMs: 200, searchCache: new TtlCache(() => now) });
    const search = (qs = ok) => cached.fetch(new Request(`http://localhost/search?${qs}`));
    return { search, calls, advance: (ms: number) => (now += ms) };
  }

  test("a repeated complete search is replayed without calling the providers", async () => {
    const { search, calls } = setup();
    const first = await read(search());
    const second = await read(search(ok.replace("bariloche", "Bariloche")));

    expect(calls).toEqual({ A: 1, B: 1 });
    expect(first[0]!.data.cached).toBe(false);
    expect(second[0]!.data.cached).toBe(true);
    const done = second.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ cached: true, complete: true, hotels: 1 });
    expect(done.data.durationMs).toBeLessThan(50);
    // Same hotels and final statuses; the original retry is not replayed.
    expect(second.map((e) => e.event)).toEqual(["search_started", "hotel", "provider_status", "provider_status", "done"]);
    expect(first.map((e) => e.event)).toEqual(["search_started", "provider_status", "hotel", "provider_status", "provider_status", "done"]);
    expect(second[1]!.data).toEqual(first[2]!.data);
  });

  test("an incomplete search is not cached", async () => {
    const { search, calls } = setup(true);
    const first = await read(search());
    expect(first.at(-1)!.data).toMatchObject({ complete: false, missing: ["B"] });
    await read(search());
    expect(calls).toEqual({ A: 2, B: 2 });
  });

  test("an entry expires after 90 s", async () => {
    const { search, calls, advance } = setup();
    await read(search());
    advance(89_999);
    await read(search());
    expect(calls.A).toBe(1);
    advance(1);
    await read(search());
    expect(calls.A).toBe(2);
  });

  test("the key includes dates, adults and children", async () => {
    const { search, calls } = setup();
    await read(search());
    await read(search(ok.replace("adults=2", "adults=3")));
    await read(search(`${ok}&children=1`));
    await read(search(ok.replace("2026-12-05", "2026-12-06")));
    expect(calls.A).toBe(4);
  });
});

describe("parseSearchParams", () => {
  const parse = (qs: string) => parseSearchParams(new URLSearchParams(qs));

  test("accepts a valid search; children defaults to 0; destination is lowercased", () => {
    expect(parse(ok.replace("bariloche", "Bariloche"))).toEqual({
      params: { destination: "bariloche", checkIn: "2026-12-01", checkOut: "2026-12-05", adults: 2, children: 0 },
    });
  });

  test("rejects bad input", () => {
    const bad = [
      "destination=paris&checkIn=2026-12-01&checkOut=2026-12-05&adults=2",
      "destination=salta&checkIn=01/12/2026&checkOut=2026-12-05&adults=2",
      "destination=salta&checkIn=2026-02-30&checkOut=2026-03-05&adults=2",
      "destination=salta&checkIn=2026-13-01&checkOut=2026-12-05&adults=2",
      "destination=salta&checkIn=2026-12-05&checkOut=2026-12-05&adults=2",
      "destination=salta&checkIn=2026-12-01&checkOut=2027-01-05&adults=2",
      "destination=salta&checkIn=2026-12-01&checkOut=2026-12-05",
      "destination=salta&checkIn=2026-12-01&checkOut=2026-12-05&adults=7",
      "destination=salta&checkIn=2026-12-01&checkOut=2026-12-05&adults=2&children=5",
      "destination=salta&checkIn=2026-12-01&checkOut=2026-12-05&adults=1.5",
    ];
    for (const qs of bad) expect(parse(qs)).toHaveProperty("error");
  });
});
