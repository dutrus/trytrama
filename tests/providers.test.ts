/**
 * Smoke tests for the fake providers: each one answers in its own format,
 * and each chaos behavior can be forced on via env.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { start as startA } from "../providers/a/src/server.ts";
import { start as startB } from "../providers/b/src/server.ts";
import { start as startC } from "../providers/c/src/server.ts";

type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];
const boot = (s: Server) => (servers.push(s), s);
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const CALM = { CHAOS: "off" };

// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
const readJson = async (res: Response | Promise<Response>): Promise<any> => (await res).json();
const stay = { checkIn: "2026-12-01", checkOut: "2026-12-05" };

const gdsBody = (inner: string) =>
  `<Envelope><Header><Credentials user="trama" password="demo"/></Header><Body>${inner}</Body></Envelope>`;
const availRQ = gdsBody(
  `<HotelAvailRQ destination="BRC" checkin="${stay.checkIn}" checkout="${stay.checkOut}"><Occupancy adults="2" children="0"/></HotelAvailRQ>`,
);

describe("provider A (Andes Wholesale)", () => {
  const path = `/v1/availability?destination=bariloche&checkIn=${stay.checkIn}&checkOut=${stay.checkOut}&adults=2`;

  test("returns camelCase JSON with USD numbers", async () => {
    const s = boot(startA({ port: 0, env: CALM, quiet: true }));
    const res = await fetch(new URL(path, s.url), { headers: { "x-api-key": "test" } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.currency).toBe("USD");
    expect(body.hotels.length).toBeGreaterThan(0);
    const room = body.hotels[0].rooms[0];
    expect(typeof room.totalPrice).toBe("number");
    expect(body.hotels[0].hotelId).toMatch(/^AW-\d+$/);
  });

  test("requires an API key", async () => {
    const s = boot(startA({ port: 0, env: CALM, quiet: true }));
    expect((await fetch(new URL(path, s.url))).status).toBe(401);
  });

  test("ERROR_RATE=1 always 500s", async () => {
    const s = boot(startA({ port: 0, env: { PROVIDER_A_LATENCY_MS: "0", PROVIDER_A_ERROR_RATE: "1" }, quiet: true }));
    const res = await fetch(new URL(path, s.url), { headers: { "x-api-key": "test" } });
    expect(res.status).toBe(500);
  });
});

describe("provider B (SurBeds)", () => {
  const path = "/api/v2/disponibilidad?ciudad_id=1&fecha_ingreso=01/12/2026&fecha_egreso=05/12/2026&adultos=2";

  test("returns snake_case, ARS strings, DD/MM/YYYY and paginates by 20", async () => {
    const s = boot(startB({ port: 0, env: CALM, quiet: true }));
    const body = await readJson(fetch(new URL(`${path}&limite=50`, s.url)));
    expect(body.data.busqueda.fecha_ingreso).toBe("01/12/2026");
    expect(body.data.hoteles.length).toBe(20);
    expect(body.paginacion.siguiente_cursor).toBeString();
    expect(body.data.hoteles[0].habitaciones[0].tarifa.precio_total).toMatch(/^\d{1,3}(\.\d{3})*,\d{2}$/);

    // Walk all pages.
    let cursor: string | undefined = body.paginacion.siguiente_cursor;
    let total = body.data.hoteles.length;
    while (cursor) {
      const page = await readJson(fetch(new URL(`${path}&cursor=${cursor}`, s.url)));
      total += page.data.hoteles.length;
      cursor = page.paginacion.siguiente_cursor;
    }
    expect(total).toBeGreaterThan(20);
  });

  test("TIMEOUT_RATE=1 never responds", async () => {
    const s = boot(startB({ port: 0, env: { PROVIDER_B_LATENCY_MS: "0", PROVIDER_B_TIMEOUT_RATE: "1" }, quiet: true }));
    const err = await fetch(new URL(path, s.url), { signal: AbortSignal.timeout(300) }).catch((e) => e);
    expect((err as Error).name).toBe("TimeoutError");
  });
});

describe("provider C (LegacyGDS)", () => {
  test("answers XML with nightly net prices", async () => {
    const s = boot(startC({ port: 0, env: CALM, quiet: true }));
    const res = await fetch(new URL("/gds", s.url), { method: "POST", body: availRQ });
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain("<HotelAvailRS");
    expect(xml).toMatch(/<Property code="BRC\d{5}"/);
    expect(xml).toMatch(/nightly="\d+\.\d{2}"/);
  });

  test("serves the tax table", async () => {
    const s = boot(startC({ port: 0, env: CALM, quiet: true }));
    const xml = await (await fetch(new URL("/gds", s.url), { method: "POST", body: gdsBody("<HotelTaxRQ/>") })).text();
    expect(xml).toContain('<Tax destination="CUN"');
  });

  test("rate limits with 429 + Retry-After", async () => {
    const s = boot(startC({ port: 0, env: { ...CALM, PROVIDER_C_RATE_LIMIT_RPS: "2" }, quiet: true }));
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => fetch(new URL("/gds", s.url), { method: "POST", body: availRQ })),
    );
    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(Number(limited[0]?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  test("errors are HTTP 200 with a Fault", async () => {
    const s = boot(startC({ port: 0, env: { PROVIDER_C_LATENCY_MS: "0", PROVIDER_C_ERROR_RATE: "1" }, quiet: true }));
    const res = await fetch(new URL("/gds", s.url), { method: "POST", body: availRQ });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Fault>");
  });
});
