import { describe, expect, test } from "bun:test";
import { TtlCache } from "./cache.ts";

describe("TtlCache", () => {
  test("expires entries after their TTL", () => {
    let now = 0;
    const cache = new TtlCache<string>(() => now);
    cache.set("k", "v", 1000);
    now = 999;
    expect(cache.get("k")).toBe("v");
    now = 1000;
    expect(cache.get("k")).toBeUndefined();
  });

  test("getOrLoad shares one load between concurrent callers", async () => {
    const cache = new TtlCache<number>();
    let loads = 0;
    const load = async () => {
      loads++;
      await Bun.sleep(10);
      return 42;
    };
    const results = await Promise.all([cache.getOrLoad("k", 1000, load), cache.getOrLoad("k", 1000, load)]);
    expect(results).toEqual([42, 42]);
    expect(await cache.getOrLoad("k", 1000, load)).toBe(42);
    expect(loads).toBe(1);
  });

  test("getOrLoad does not cache a failed load", async () => {
    const cache = new TtlCache<number>();
    await expect(cache.getOrLoad("k", 1000, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await cache.getOrLoad("k", 1000, async () => 7)).toBe(7);
  });
});
