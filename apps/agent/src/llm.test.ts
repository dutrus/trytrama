import { describe, expect, test } from "bun:test";
import { type Content, createGemini, LlmError } from "./llm.ts";

const KEY = "test-key-123";
const req = { system: "sys", contents: [{ role: "user", parts: [{ text: "hola" }] }] as Content[], tools: [] };

/** An SSE body with one data line per chunk, as Gemini sends it. */
const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const chunk = (...parts: unknown[]) => ({ candidates: [{ content: { role: "model", parts } }] });

function fakeFetch(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses[calls.length - 1]!();
  }) as unknown as typeof fetch;
  return { f, calls };
}

const sleeps: number[] = [];
const gemini = (f: typeof fetch, extra = {}) =>
  createGemini({ apiKey: KEY, model: "m", fetch: f, sleep: async (ms) => void sleeps.push(ms), ...extra });

describe("gemini", () => {
  test("streams visible text and returns every part unchanged, thoughtSignature included", async () => {
    const call = { functionCall: { name: "search_hotels", args: { destination: "salta" } }, thoughtSignature: "sig==" };
    const { f, calls } = fakeFetch([() => sse(chunk({ text: "Hola " }), chunk({ text: "pensando", thought: true }), chunk({ text: "mundo" }, call))]);
    const seen: string[] = [];
    const parts = await gemini(f).generate(req, (t) => seen.push(t));

    expect(seen).toEqual(["Hola ", "mundo"]);
    expect(parts).toEqual([{ text: "Hola " }, { text: "pensando", thought: true }, { text: "mundo" }, call]);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse");
    expect(new Headers(calls[0]!.init.headers).get("x-goog-api-key")).toBe(KEY);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ systemInstruction: { parts: [{ text: "sys" }] }, contents: req.contents });
  });

  test("retries 503 and 429, honoring the delay Gemini asks for", async () => {
    sleeps.length = 0;
    const { f, calls } = fakeFetch([
      () => new Response("overloaded", { status: 503 }),
      () => new Response(JSON.stringify({ error: { details: [{ retryDelay: "7s" }] } }), { status: 429 }),
      () => sse(chunk({ text: "ok" })),
    ]);
    const parts = await gemini(f).generate(req, () => {});
    expect(parts).toEqual([{ text: "ok" }]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 7000]);
  });

  test("each retry is announced before waiting", async () => {
    const { f } = fakeFetch([() => new Response("", { status: 503 }), () => sse(chunk({ text: "ok" }))]);
    const waits: unknown[] = [];
    await gemini(f).generate(req, () => {}, (info) => waits.push(info));
    expect(waits).toEqual([{ status: 503, waitMs: 1000, attempt: 2 }]);
  });

  test("an exhausted quota that asks for a long wait fails at once instead of hanging", async () => {
    sleeps.length = 0;
    const quota = JSON.stringify({ error: { code: 429, details: [{ retryDelay: "3277s" }] } });
    const { f, calls } = fakeFetch([() => new Response(quota, { status: 429 })]);
    const err = await gemini(f).generate(req, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toBe("Se agotó la cuota de Gemini (429): pide esperar unos 55 minutos. Probá más tarde o con otro modelo en GEMINI_MODEL.");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("when Gemini stays unavailable it fails with a clear message", async () => {
    const { f, calls } = fakeFetch(Array(4).fill(() => new Response("", { status: 503 })));
    const err = await gemini(f).generate(req, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("no está disponible");
    expect(calls).toHaveLength(4);
  });

  test("other errors are not retried", async () => {
    const { f, calls } = fakeFetch([() => new Response("", { status: 404 })]);
    const err = await gemini(f).generate(req, () => {}).catch((e) => e);
    expect(err.message).toContain("El modelo m no existe");
    expect(calls).toHaveLength(1);
  });

  test("the API key never shows up in an error, even if Gemini echoes it", async () => {
    for (const status of [400, 403, 503]) {
      const { f } = fakeFetch(Array(4).fill(() => new Response(`bad key ${KEY}`, { status })));
      const err = await gemini(f).generate(req, () => {}).catch((e) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(String(err.message)).not.toContain(KEY);
      expect(String(err.stack)).not.toContain(KEY);
    }
  });

  test("a missing key or network failure gives a clear message", async () => {
    const noKey = await createGemini({ apiKey: "", fetch: fakeFetch([]).f }).generate(req, () => {}).catch((e) => e);
    expect(noKey.message).toContain("Falta GEMINI_API_KEY");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const net = await gemini(down).generate(req, () => {}).catch((e) => e);
    expect(net.message).toContain("No pude conectarme con Gemini");
  });
});
