/**
 * Provider A — "Andes Wholesale"
 * REST + JSON, camelCase, USD numbers. Fast-ish, occasionally 500s.
 */
import {
  Chaos,
  type DestinationKey,
  DESTINATIONS,
  type ProviderServerOptions,
  chaosFromEnv,
  hotelsFor,
  json,
  logger,
  quote,
  requestKey,
  sleep,
  unit,
  validateStay,
} from "@mocks/kit";

const BOARD_LABEL: Record<string, string> = { RO: "Room only", BB: "Bed & breakfast", HB: "Half board", FB: "Full board", AI: "All inclusive" };

export function start(opts: ProviderServerOptions = {}) {
  const env = opts.env ?? process.env;
  const chaos = new Chaos("a", chaosFromEnv("PROVIDER_A", { latencyMs: [150, 400], errorRate: 0.03, timeoutRate: 0 }, env));
  const log = logger("A", opts.quiet);

  const server = Bun.serve({
    port: opts.port ?? Number(env.PROVIDER_A_PORT ?? 4001),
    async fetch(req) {
      const t0 = performance.now();
      const url = new URL(req.url);

      if (url.pathname === "/health") return json({ ok: true, provider: "andes-wholesale" });

      if (!req.headers.get("x-api-key")) {
        log(req, 401, t0);
        return json({ error: "UNAUTHORIZED", message: "Missing X-Api-Key header" }, { status: 401 });
      }

      if (req.method === "GET" && url.pathname === "/v1/destinations") {
        return json({ destinations: DESTINATIONS.map((d) => ({ code: d.key, name: d.name, country: d.country })) });
      }

      if (req.method === "GET" && url.pathname === "/v1/availability") {
        const roll = chaos.roll(requestKey(req));
        await sleep(roll.latencyMs);

        if (roll.error) {
          log(req, 500, t0, "chaos");
          return roll.rand() < 0.5
            ? new Response("<html><body><h1>500 Internal Server Error</h1><hr>nginx</body></html>", {
                status: 500,
                headers: { "content-type": "text/html" },
              })
            : json({ error: "INTERNAL", message: "Inventory service unavailable" }, { status: 500 });
        }

        const q = url.searchParams;
        const destination = q.get("destination") as DestinationKey | null;
        const stay = {
          checkIn: q.get("checkIn") ?? "",
          checkOut: q.get("checkOut") ?? "",
          adults: Number(q.get("adults") ?? 2),
          children: Number(q.get("children") ?? 0),
        };
        const invalid = !DESTINATIONS.some((d) => d.key === destination) ? "unknown destination" : validateStay(stay);
        if (invalid || !destination) {
          log(req, 400, t0);
          return json({ error: "VALIDATION", message: invalid }, { status: 400 });
        }

        const hotels = hotelsFor("a", destination)
          .map((hotel) => ({ hotel, quotes: quote(hotel, "a", stay) }))
          .filter((x) => x.quotes.length > 0)
          .map(({ hotel, quotes }) => {
            const out: Record<string, unknown> = {
              hotelId: hotel.ids.a,
              name: hotel.name,
              ...(unit(hotel.id, "a-stars") < 0.06 ? {} : { starRating: hotel.stars }),
              address: hotel.address,
              geo: { lat: hotel.lat, lng: hotel.lng },
              rooms: quotes.map((qt) => ({
                roomCode: `${qt.room.code}-${qt.room.board}`,
                roomName: `${qt.room.name} - ${BOARD_LABEL[qt.room.board]}`,
                boardType: qt.room.board,
                maxOccupancy: qt.room.capacity,
                totalPrice: qt.totalUsd,
                ...(unit(hotel.id, qt.room.code, "a-ref") < 0.1 ? {} : { refundable: qt.refundable }),
              })),
            };
            return out;
          });

        log(req, 200, t0, `${hotels.length} hotels`);
        return json({
          searchId: `aw_${Bun.hash(requestKey(req)).toString(36)}`,
          destination,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          currency: "USD",
          hotels,
        });
      }

      log(req, 404, t0);
      return json({ error: "NOT_FOUND" }, { status: 404 });
    },
  });

  if (!opts.quiet) console.log(`[A] Andes Wholesale listening on ${server.url}`);
  return server;
}

if (import.meta.main) start();
