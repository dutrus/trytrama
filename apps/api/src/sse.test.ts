import { describe, expect, test } from "bun:test";
import { formatEvent, sseResponse } from "./sse.ts";

describe("formatEvent", () => {
  test("writes event and JSON data, ended by a blank line", () => {
    expect(formatEvent("done", { ok: true })).toBe('event: done\ndata: {"ok":true}\n\n');
  });

  test("JSON keeps newlines inside data escaped", () => {
    expect(formatEvent("hotel", { name: "a\nb" })).toBe('event: hotel\ndata: {"name":"a\\nb"}\n\n');
  });
});

describe("sseResponse", () => {
  test("streams events in order with SSE headers and closes when run ends", async () => {
    const res = sseResponse(async (send) => {
      send("search_started", { n: 1 });
      await Bun.sleep(5);
      send("done", { n: 2 });
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(formatEvent("search_started", { n: 1 }) + formatEvent("done", { n: 2 }));
  });

  test("the first event reaches the client before run finishes", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const res = sseResponse(async (send) => {
      send("search_started", {});
      await finished;
      send("done", {});
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(formatEvent("search_started", {}));
    finish();
    expect((await reader.read()).value).toBe(formatEvent("done", {}));
    expect((await reader.read()).done).toBe(true);
  });

  test("a client that cancels aborts the run's signal", async () => {
    let seen: AbortSignal | undefined;
    const res = sseResponse(async (send, signal) => {
      seen = signal;
      send("search_started", {});
      await new Promise((r) => signal.addEventListener("abort", r));
      send("done", {}); // dropped
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(5);
    expect(seen?.aborted).toBe(true);
  });

  test("the request signal also aborts the run", async () => {
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    const res = sseResponse(async (_send, signal) => {
      seen = signal;
    }, request.signal);
    request.abort();
    await res.text();
    expect(seen?.aborted).toBe(true);
  });
});
