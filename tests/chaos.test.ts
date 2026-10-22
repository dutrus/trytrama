/**
 * CHAOS_SEED must make chaos reproducible: same seed + same requests => same outcomes.
 */
import { describe, expect, test } from "bun:test";
import { Chaos, chaosFromEnv, getCatalog } from "@mocks/kit";
import { start as startA } from "../providers/a/src/server.ts";

const config = (seed: string | null) => ({ enabled: true, seed, latencyMs: [100, 3000] as [number, number], errorRate: 0.2, timeoutRate: 0.1 });
const keys = Array.from({ length: 50 }, (_, i) => `GET /search?i=${i % 10}`);
const outcomes = (chaos: Chaos) => keys.map((k) => chaos.roll(k)).map(({ latencyMs, error, timeout }) => ({ latencyMs, error, timeout }));

describe("chaos", () => {
  test("same seed => same rolls", () => {
    expect(outcomes(new Chaos("x", config("42")))).toEqual(outcomes(new Chaos("x", config("42"))));
  });

  test("different seed => different rolls", () => {
    expect(outcomes(new Chaos("x", config("42")))).not.toEqual(outcomes(new Chaos("x", config("43"))));
  });

  test("retries of the same request get a new roll", () => {
    const chaos = new Chaos("x", config("42"));
    const rolls = Array.from({ length: 10 }, () => chaos.roll("same").latencyMs);
    expect(new Set(rolls).size).toBeGreaterThan(1);
  });

  test("CHAOS=off disables latency and errors", () => {
    const chaos = new Chaos("x", chaosFromEnv("P", { latencyMs: [500, 900], errorRate: 1, timeoutRate: 0 }, { CHAOS: "off" }));
    expect(chaos.roll("k")).toMatchObject({ latencyMs: 0, error: false, timeout: false });
  });

  test("seeded provider A returns the same status sequence on a fresh boot", async () => {
    const env = { CHAOS_SEED: "trama", PROVIDER_A_LATENCY_MS: "0", PROVIDER_A_ERROR_RATE: "0.5" };
    const run = async () => {
      const s = startA({ port: 0, env, quiet: true });
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const url = new URL(`/v1/availability?destination=salta&checkIn=2026-12-0${(i % 3) + 1}&checkOut=2026-12-09&adults=2`, s.url);
        statuses.push((await fetch(url, { headers: { "x-api-key": "t" } })).status);
      }
      s.stop(true);
      return statuses;
    };
    const first = await run();
    expect(first).toContain(500);
    expect(first).toContain(200);
    expect(await run()).toEqual(first);
  });
});

describe("catalog", () => {
  test("is deterministic and has cross-provider overlap", () => {
    const hotels = getCatalog();
    expect(hotels.length).toBe(200);
    expect(getCatalog("other-seed")[0]).not.toEqual(hotels[0]);
    expect(hotels.filter((h) => Object.keys(h.ids).length > 1).length).toBeGreaterThan(80);
  });
});
