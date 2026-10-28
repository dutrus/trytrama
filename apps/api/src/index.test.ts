import { describe, expect, test } from "bun:test";
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
