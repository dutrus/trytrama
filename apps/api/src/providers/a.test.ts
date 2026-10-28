/**
 * Provider A adapter against a local fake that speaks A's format.
 * We don't import providers/: the fake only serves canned responses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SearchParams } from "../types.ts";
import { createProviderA } from "./a.ts";

const params: SearchParams = {
  destination: "bariloche",
  checkIn: "2026-12-01",
  checkOut: "2026-12-05",
  adults: 2,
  children: 0,
};

const okBody = {
  currency: "USD",
  hotels: [
    {
      hotelId: "AW-10002",
      name: "Cabañas Cerro Otto",
      starRating: 4,
      address: "Elflein 1597",
      geo: { lat: -41.134521, lng: -71.294469 },
      rooms: [
        {
          roomCode: "TWN-BB",
          roomName: "Twin Standard - Bed & breakfast",
          boardType: "BB",
          maxOccupancy: 2,
          totalPrice: 766.1,
          refundable: true,
        },
      ],
    },
    {
      hotelId: "AW-10003",
      name: "Hotel Colonia Suiza",
      address: "Moreno 233",
      geo: { lat: -41.13, lng: -71.3 },
      rooms: [{ roomCode: "DBL-RO", roomName: "Double - Room only", boardType: "RO", maxOccupancy: 2, totalPrice: 500 }],
    },
  ],
};

const htmlError = () =>
  new Response("<html><body><h1>500 Internal Server Error</h1></body></html>", {
    status: 500,
    headers: { "content-type": "text/html" },
  });

type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Serves the given responses in order and records each request. */
function fakeA(responses: (() => Response)[]) {
  // Copied eagerly: Bun's Request isn't readable after the handler returns.
  const requests: { url: URL; apiKey: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push({ url: new URL(req.url), apiKey: req.headers.get("x-api-key") });
      const next = responses[requests.length - 1];
      return next ? next() : new Response("unexpected request", { status: 599 });
    },
  });
  servers.push(server);
  const adapter = createProviderA({ baseUrl: server.url.href, apiKey: "test-key" });
  return { adapter, requests };
}

const opts = () => ({ signal: new AbortController().signal });

describe("provider A adapter", () => {
  test("parses hotels and offers into the common format", async () => {
    const { adapter, requests } = fakeA([() => Response.json(okBody)]);
    const hotels = await adapter.search(params, opts());

    expect(hotels[0]).toEqual({
      provider: "A",
      providerHotelId: "AW-10002",
      name: "Cabañas Cerro Otto",
      stars: 4,
      address: "Elflein 1597",
      coords: { lat: -41.134521, lng: -71.294469 },
      offers: [
        {
          provider: "A",
          roomType: "TWN",
          roomName: "Twin Standard - Bed & breakfast",
          board: "BB",
          capacity: 2,
          refundable: true,
          totalUsd: 766.1,
        },
      ],
    });
    const { url } = requests[0]!;
    expect(url.pathname).toBe("/v1/availability");
    expect(url.searchParams.get("destination")).toBe("bariloche");
    expect(url.searchParams.get("checkIn")).toBe("2026-12-01");
    expect(url.searchParams.get("adults")).toBe("2");
  });

  test("sends the API key", async () => {
    const { adapter, requests } = fakeA([() => Response.json(okBody)]);
    await adapter.search(params, opts());
    expect(requests[0]!.apiKey).toBe("test-key");
  });

  test("missing starRating and refundable become null", async () => {
    const { adapter } = fakeA([() => Response.json(okBody)]);
    const [, suiza] = await adapter.search(params, opts());
    expect(suiza!.stars).toBeNull();
    expect(suiza!.offers[0]!.refundable).toBeNull();
  });

  test("roomType comes from the roomCode prefix; an unknown code is null", async () => {
    const body = structuredClone(okBody);
    body.hotels[1]!.rooms[0]!.roomCode = "PENT-RO";
    const { adapter } = fakeA([() => Response.json(body)]);
    const [otto, suiza] = await adapter.search(params, opts());
    expect(otto!.offers[0]!.roomType).toBe("TWN");
    expect(suiza!.offers[0]!.roomType).toBeNull();
    expect(suiza!.offers[0]!.roomName).toBe("Double - Room only");
  });

  test("retries once after an HTML 500 and reports the retry", async () => {
    const { adapter, requests } = fakeA([htmlError, () => Response.json(okBody)]);
    const retries: { attempt: number; reason: string }[] = [];
    const hotels = await adapter.search(params, { ...opts(), onRetry: (r) => retries.push(r) });
    expect(hotels).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(retries).toEqual([{ attempt: 2, reason: "HTTP 500" }]);
  });

  test("fails after two 500s", async () => {
    const { adapter, requests } = fakeA([
      htmlError,
      () => Response.json({ error: "INTERNAL", message: "Inventory service unavailable" }, { status: 500 }),
    ]);
    await expect(adapter.search(params, opts())).rejects.toThrow("HTTP 500");
    expect(requests).toHaveLength(2);
  });

  test("does not retry a 400", async () => {
    const { adapter, requests } = fakeA([
      () => Response.json({ error: "VALIDATION", message: "bad" }, { status: 400 }),
      () => Response.json(okBody),
    ]);
    await expect(adapter.search(params, opts())).rejects.toThrow("HTTP 400");
    expect(requests).toHaveLength(1);
  });

  test("does not retry when the signal is already aborted", async () => {
    const controller = new AbortController();
    const { adapter, requests } = fakeA([
      () => {
        controller.abort(new Error("search deadline"));
        return htmlError();
      },
      () => Response.json(okBody),
    ]);
    let retried = false;
    await expect(
      adapter.search(params, { signal: controller.signal, onRetry: () => (retried = true) }),
    ).rejects.toThrow("search deadline");
    expect(requests).toHaveLength(1);
    expect(retried).toBe(false);
  });
});
