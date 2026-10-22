/**
 * Provider C — "LegacyGDS"
 * SOAP-ish XML over POST. Own hotel codes, nightly NET prices (no taxes),
 * taxes in a separate table. Slow, rate limited to N req/s globally.
 */
import {
  Chaos,
  DESTINATIONS,
  type ProviderServerOptions,
  chaosFromEnv,
  hotelsFor,
  logger,
  quote,
  requestKey,
  sleep,
  stripAccents,
  validateStay,
} from "@mocks/kit";

const ABBR: Record<string, string> = {
  Hotel: "HTL",
  Hostería: "HOST",
  Apart: "APT",
  Cabañas: "CAB",
  Lodge: "LDG",
  "Boutique Hotel": "BTQ HTL",
  "Resort & Spa": "RST & SPA",
  Posada: "POS",
  "Wine Lodge": "WINE LDG",
  Hostal: "HOSTAL",
  Pousada: "POUS",
  Resort: "RST",
  Flat: "FLAT",
  Hostel: "HSTL",
  "Grand Resort": "GRAND RST",
  Suites: "STES",
  "Beach Club": "BCH CLUB",
};

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function attr(xml: string, element: string, name: string): string | null {
  const el = xml.match(new RegExp(`<${element}\\b([^>]*)>`))?.[1];
  return el?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

function envelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Envelope xmlns="urn:legacygds:v1">\n<Body>\n${body}\n</Body>\n</Envelope>\n`;
}

function xml(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(envelope(body), { status, headers: { "content-type": "text/xml; charset=utf-8", ...headers } });
}

function fault(code: string, message: string): string {
  return `<Fault><Code>${code}</Code><Message>${escapeXml(message)}</Message></Fault>`;
}

/** Simple token bucket shared by all clients. */
class RateLimiter {
  private tokens: number;
  private last = performance.now();
  constructor(private readonly rps: number) {
    this.tokens = rps;
  }
  /** Returns 0 if allowed, otherwise seconds to wait. */
  take(): number {
    const now = performance.now();
    this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.rps));
  }
}

export function start(opts: ProviderServerOptions = {}) {
  const env = opts.env ?? process.env;
  const chaos = new Chaos("c", chaosFromEnv("PROVIDER_C", { latencyMs: [300, 3000], errorRate: 0.02, timeoutRate: 0 }, env));
  const rps = Number(env.PROVIDER_C_RATE_LIMIT_RPS ?? 5);
  const limiter = rps > 0 ? new RateLimiter(rps) : null;
  const log = logger("C", opts.quiet);

  const server = Bun.serve({
    port: opts.port ?? Number(env.PROVIDER_C_PORT ?? 4003),
    async fetch(req) {
      const t0 = performance.now();
      const url = new URL(req.url);

      if (url.pathname === "/health") return new Response("OK");
      if (req.method !== "POST" || url.pathname !== "/gds") {
        log(req, 404, t0);
        return xml(fault("GDS-404", "Unknown service"), 404);
      }

      const wait = limiter?.take() ?? 0;
      if (wait > 0) {
        log(req, 429, t0, "rate limited");
        return xml(fault("GDS-429", "Too many requests"), 429, { "retry-after": String(wait) });
      }

      const body = await req.text();
      const roll = chaos.roll(requestKey(req, body));
      await sleep(roll.latencyMs);

      if (!attr(body, "Credentials", "user") || !attr(body, "Credentials", "password")) {
        log(req, 200, t0, "auth fault");
        return xml(fault("GDS-401", "Invalid credentials"));
      }

      if (roll.error) {
        log(req, 200, t0, "chaos fault");
        return xml(fault("GDS-503", "Host system timeout, please retry"));
      }

      if (/<HotelTaxRQ\b/.test(body)) {
        const taxes = DESTINATIONS.map(
          (d) => `  <Tax destination="${d.iata}" pct="${(d.taxes.pct * 100).toFixed(1)}" perNight="${d.taxes.perNightUsd.toFixed(2)}" cur="USD"/>`,
        ).join("\n");
        log(req, 200, t0, "taxes");
        return xml(`<HotelTaxRS>\n${taxes}\n</HotelTaxRS>`);
      }

      if (!/<HotelAvailRQ\b/.test(body)) {
        log(req, 200, t0, "bad request fault");
        return xml(fault("GDS-400", "Unsupported request"));
      }

      const dest = DESTINATIONS.find((d) => d.iata === attr(body, "HotelAvailRQ", "destination"));
      const stay = {
        checkIn: attr(body, "HotelAvailRQ", "checkin") ?? "",
        checkOut: attr(body, "HotelAvailRQ", "checkout") ?? "",
        adults: Number(attr(body, "Occupancy", "adults") ?? 2),
        children: Number(attr(body, "Occupancy", "children") ?? 0),
      };
      const invalid = !dest ? "Unknown destination" : validateStay(stay);
      if (invalid || !dest) {
        log(req, 200, t0, "validation fault");
        return xml(fault("GDS-422", invalid ?? "Invalid request"));
      }

      const properties = hotelsFor("c", dest.key)
        .map((hotel) => ({ hotel, quotes: quote(hotel, "c", stay) }))
        .filter((x) => x.quotes.length > 0)
        .map(({ hotel, quotes }) => {
          const name = stripAccents(`${ABBR[hotel.type] ?? hotel.type} ${hotel.core}`).toUpperCase().slice(0, 24);
          const rates = quotes
            .map(
              (qt) =>
                `    <Rate room="${qt.room.code}" plan="${qt.room.board}" nightly="${qt.nightlyNetUsd.toFixed(2)}" maxPax="${qt.room.capacity}" refundable="${qt.refundable ? "Y" : "N"}"/>`,
            )
            .join("\n");
          return `  <Property code="${hotel.ids.c}" name="${escapeXml(name)}" category="${hotel.stars}" addr="${escapeXml(stripAccents(hotel.address).toUpperCase())}">\n${rates}\n  </Property>`;
        });

      log(req, 200, t0, `${properties.length} properties`);
      return xml(
        `<HotelAvailRS destination="${dest.iata}" checkin="${stay.checkIn}" checkout="${stay.checkOut}" currency="USD" count="${properties.length}">\n${properties.join("\n")}\n</HotelAvailRS>`,
      );
    },
  });

  if (!opts.quiet) console.log(`[C] LegacyGDS listening on ${server.url}`);
  return server;
}

if (import.meta.main) start();
