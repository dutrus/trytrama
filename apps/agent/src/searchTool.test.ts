import { describe, expect, test } from "bun:test";
import { SearchApiError, searchHotels } from "./searchTool.ts";

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const offer = (provider: string, totalUsd: number, roomType: string | null, board = "BB", roomName = "x") => ({
  provider,
  roomType,
  roomName,
  board,
  capacity: 2,
  refundable: provider === "A" ? null : true,
  totalUsd,
});
const params = { destination: "bariloche", checkIn: "2026-12-01", checkOut: "2026-12-05", adults: 2, children: 0 };

const stream = (cached = false) =>
  [
    ev("search_started", { params, providers: ["A", "B", "C"], deadlineMs: 5500, cached }),
    ev("hotel", { id: "A-1", name: "Cabañas Cerro Otto", stars: 4, offers: [offer("A", 766.1, "TWN"), offer("A", 1570, "STE")] }),
    ev("hotel", { id: "A-2", name: "Hotel Catedral", stars: 3, offers: [offer("A", 660.4, null, "RO", "Mystery Room")] }),
    ev("provider_status", { provider: "A", status: "ok", hotels: 2, ms: 300 }),
    ev("offer", { hotelId: "A-1", provider: "C", offers: [offer("C", 753.04, "TWN"), offer("C", 1198.85, "FAM", "HB")] }),
    ev("hotel", { id: "C-9", name: "CAB COLONIA SUIZA", stars: 5, matchNote: "Misma dirección que …", offers: [offer("C", 1613.2, "DBL")] }),
    ev("provider_status", { provider: "C", status: "ok", hotels: 2, ms: 1800 }),
    ev("provider_status", { provider: "B", status: "retrying", attempt: 2, reason: "no response after 2600 ms" }),
    ev("provider_status", { provider: "B", status: "partial", hotels: 12, ms: 5500, reason: "timeout", message: "x" }),
    ev("done", {
      cached,
      durationMs: 5500,
      firstHotelMs: 300,
      hotels: 3,
      complete: false,
      missing: ["B"],
      providers: {
        A: { status: "ok", hotels: 2, ms: 300 },
        C: { status: "ok", hotels: 2, ms: 1800 },
        B: { status: "partial", hotels: 12, ms: 5500, reason: "timeout", message: "x" },
      },
    }),
  ].join("");

function fakeApi(response: () => Response) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return response();
  }) as unknown as typeof fetch;
  return { f, urls };
}

const sseResponse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

describe("searchHotels", () => {
  test("merges offers, sorts by price and gives the model a compact result", async () => {
    const { f, urls } = fakeApi(() => sseResponse(stream()));
    const progress: string[] = [];
    const out = await searchHotels({ ...params, destination: " Bariloche " }, { apiUrl: "http://api", fetch: f, onProgress: (m) => progress.push(m) });

    expect(urls[0]).toBe("http://api/search?destination=bariloche&checkIn=2026-12-01&checkOut=2026-12-05&adults=2&children=0");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result;
    expect(r.search).toEqual(params);
    expect(r).toMatchObject({ cached: false, complete: false, missing: ["B"] });
    expect(r.providers.B).toEqual({ status: "partial", hotels: 12, reason: "timeout" });
    expect(r.hotels.map((h) => h.id)).toEqual(["A-2", "A-1", "C-9"]);

    const otto = r.hotels[1]!;
    expect(otto.offers).toEqual([
      { priceUsd: 753.04, room: "Doble twin", board: "desayuno", refundable: true, provider: "C" },
      { priceUsd: 766.1, room: "Doble twin", board: "desayuno", refundable: null, provider: "A" },
      { priceUsd: 1198.85, room: "Familiar", board: "media pensión", refundable: true, provider: "C" },
    ]);
    expect(otto.moreOffers).toBe(1);
    expect(r.hotels[0]!.offers[0]).toMatchObject({ room: "Mystery Room", board: "solo alojamiento" });
    expect(r.hotels[2]!.matchNote).toBe("Misma dirección que …");

    expect(progress).toEqual([
      "Buscando en A, B, C…",
      "A: 2 hoteles; lo más barato hasta ahora: USD 660.40",
      "C: 2 hoteles; lo más barato hasta ahora: USD 660.40",
      "B: reintentando",
      "B: respondió en parte (12 hoteles; se cortó por tiempo)",
    ]);
  });

  test("a cached answer says so", async () => {
    const { f } = fakeApi(() => sseResponse(stream(true)));
    const progress: string[] = [];
    const out = await searchHotels(params, { fetch: f, onProgress: (m) => progress.push(m) });
    expect(out.ok && out.result.cached).toBe(true);
    expect(progress[0]).toContain("caché");
  });

  test("a 400 goes back to the model as a tool error", async () => {
    const { f } = fakeApi(() => Response.json({ error: "invalid_params", message: "checkOut must be after checkIn" }, { status: 400 }));
    expect(await searchHotels(params, { fetch: f })).toEqual({ ok: false, error: "Búsqueda rechazada: checkOut must be after checkIn" });
  });

  test("an API that is down gives a clear message", async () => {
    const down = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    const err = await searchHotels(params, { apiUrl: "http://localhost:3999", fetch: down }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchApiError);
    expect(err.message).toBe('No pude conectarme con la API de búsqueda en http://localhost:3999. ¿Está corriendo "bun dev"?');
  });

  test("a stream that ends without done is an error", async () => {
    const { f } = fakeApi(() => sseResponse(ev("search_started", { params, providers: ["A"], cached: false })));
    await expect(searchHotels(params, { fetch: f })).rejects.toBeInstanceOf(SearchApiError);
  });

  test("reads events split across chunks", async () => {
    const body = stream();
    const chunks = body.match(/[\s\S]{1,7}/g)!;
    const { f } = fakeApi(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
              c.close();
            },
          }),
        ),
    );
    const out = await searchHotels(params, { fetch: f });
    expect(out.ok && out.result.hotels).toHaveLength(3);
  });
});
