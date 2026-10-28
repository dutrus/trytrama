/**
 * Provider C adapter against a local fake that speaks C's XML.
 * We don't import providers/: the fake only serves canned responses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { TtlCache } from "../cache.ts";
import { ProviderError, type SearchParams } from "../types.ts";
import { RateLimiter, createProviderC, decodeEntities } from "./c.ts";

const params: SearchParams = {
  destination: "cancun",
  checkIn: "2026-12-01",
  checkOut: "2026-12-05",
  adults: 2,
  children: 0,
};

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Envelope xmlns="urn:legacygds:v1">\n<Body>\n${body}\n</Body>\n</Envelope>\n`;
const xml = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(envelope(body), { status, headers: { "content-type": "text/xml; charset=utf-8", ...headers } });
const fault = (code: string, message: string) => xml(`<Fault><Code>${code}</Code><Message>${message}</Message></Fault>`);

// Real table, not the manual's: Cancún is 19% + USD 4.50 per night (manual says 16%).
const taxRS = () =>
  xml(`<HotelTaxRS>
  <Tax destination="BRC" pct="21.0" perNight="2.50" cur="USD"/>
  <Tax destination="CUN" pct="19.0" perNight="4.50" cur="USD"/>
</HotelTaxRS>`);

const availRS = () =>
  xml(`<HotelAvailRS destination="CUN" checkin="2026-12-01" checkout="2026-12-05" currency="USD" count="2">
  <Property code="CUN00003" name="HTL PLAYA DELFINES" category="2" addr="AV. BONAMPAK 1189">
    <Rate room="STE" plan="BB" nightly="172.97" maxPax="2" refundable="N"/>
    <Rate room="DBL" plan="XX" nightly="82.37" maxPax="2" refundable="Y"/>
  </Property>
  <Property code="CUN00012" name="RST &amp; SPA PUERTO JUAREZ" category="9" addr="AV. BONAMPAK 1225">
    <Rate room="DBL" plan="AI" nightly="272.09" maxPax="2" refundable="?"/>
  </Property>
</HotelAvailRS>`);

type Handler = (body: string, n: number) => Response | Promise<Response>;
type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Routes HotelTaxRQ and HotelAvailRQ to handlers; records each request body. */
function fakeC(handlers: { tax?: Handler; avail: Handler }) {
  const bodies: string[] = [];
  let taxCalls = 0;
  let availCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      bodies.push(body);
      if (body.includes("<HotelTaxRQ")) return (handlers.tax ?? taxRS)(body, ++taxCalls);
      return handlers.avail(body, ++availCalls);
    },
  });
  servers.push(server);
  const adapter = createProviderC({
    baseUrl: server.url.href,
    limiter: new RateLimiter(1000),
    taxCache: new TtlCache(),
  });
  return { adapter, bodies, taxCalls: () => taxCalls, availCalls: () => availCalls };
}

const opts = () => ({ signal: new AbortController().signal });

describe("decodeEntities", () => {
  test("decodes named and numeric entities", () => {
    expect(decodeEntities("RST &amp; SPA &lt;&gt;&quot;&apos; &#233; &#xE9;")).toBe(`RST & SPA <>"' é é`);
  });
});

describe("RateLimiter", () => {
  test("never lets more than rps requests through per second", async () => {
    const limiter = new RateLimiter(10);
    const signal = new AbortController().signal;
    const t0 = performance.now();
    for (let i = 0; i < 15; i++) await limiter.acquire(signal);
    // 10 from the initial burst, then 5 more at 10/s.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(450);
  });

  test("a smaller burst delays the rest at the same rate", async () => {
    const limiter = new RateLimiter(20, 5);
    const signal = new AbortController().signal;
    const t0 = performance.now();
    for (let i = 0; i < 15; i++) await limiter.acquire(signal);
    // 5 from the burst, then 10 more at 20/s.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(450);
  });
});

describe("provider C adapter", () => {
  test("prices with the HotelTaxRQ table: nightly * nights * (1 + pct) + perNight * nights", async () => {
    const { adapter } = fakeC({ avail: availRS });
    const [delfines] = await adapter.search(params, opts());

    expect(delfines).toEqual({
      provider: "C",
      providerHotelId: "CUN00003",
      name: "HTL PLAYA DELFINES",
      stars: 2,
      address: "AV. BONAMPAK 1189",
      coords: null,
      // 172.97 * 4 * 1.19 + 4.50 * 4 = 841.3372 -> 841.34; the DBL rate has an unknown plan and is skipped.
      offers: [{ provider: "C", roomName: "STE", board: "BB", capacity: 2, refundable: false, totalUsd: 841.34 }],
    });
  });

  test("decodes entities, keeps the abbreviated name, unknown values become null", async () => {
    const { adapter } = fakeC({ avail: availRS });
    const [, juarez] = await adapter.search(params, opts());
    expect(juarez!.name).toBe("RST & SPA PUERTO JUAREZ");
    expect(juarez!.stars).toBeNull();
    expect(juarez!.offers[0]!.refundable).toBeNull();
  });

  test("sends credentials and the request as XML", async () => {
    const { adapter, bodies } = fakeC({ avail: availRS });
    await adapter.search(params, opts());
    const rq = bodies.find((b) => b.includes("<HotelAvailRQ"))!;
    expect(rq).toContain('<Credentials user="trama" password="demo"/>');
    expect(rq).toContain('<HotelAvailRQ destination="CUN" checkin="2026-12-01" checkout="2026-12-05">');
    expect(rq).toContain('<Occupancy adults="2" children="0"/>');
  });

  test("a Fault inside an HTTP 200 is an error", async () => {
    const { adapter } = fakeC({ avail: () => fault("GDS-401", "Invalid credentials") });
    const err = await adapter.search(params, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe("error");
    expect(String(err)).toContain("GDS-401");
  });

  test("retries a GDS-503 once and reports it", async () => {
    const { adapter, availCalls } = fakeC({
      avail: (_b, n) => (n === 1 ? fault("GDS-503", "Host system timeout, please retry") : availRS()),
    });
    const retries: { attempt: number; reason: string }[] = [];
    const hotels = await adapter.search(params, { ...opts(), onRetry: (r) => retries.push(r) });
    expect(hotels).toHaveLength(2);
    expect(availCalls()).toBe(2);
    expect(retries).toEqual([{ attempt: 2, reason: "GDS-503 Host system timeout, please retry" }]);
  });

  test("fails after a second GDS-503", async () => {
    const { adapter, availCalls } = fakeC({ avail: () => fault("GDS-503", "Host system timeout, please retry") });
    await expect(adapter.search(params, opts())).rejects.toThrow("GDS-503");
    expect(availCalls()).toBe(2);
  });

  test("waits Retry-After on a 429, then retries", async () => {
    const { adapter, availCalls } = fakeC({
      avail: (_b, n) => (n === 1 ? xml("<Fault><Code>GDS-429</Code></Fault>", 429, { "retry-after": "1" }) : availRS()),
    });
    const retries: { attempt: number; reason: string }[] = [];
    const t0 = performance.now();
    const hotels = await adapter.search(params, { ...opts(), onRetry: (r) => retries.push(r) });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(950);
    expect(hotels).toHaveLength(2);
    expect(availCalls()).toBe(2);
    expect(retries).toEqual([{ attempt: 2, reason: "rate limited, retry after 1000 ms" }]);
  });

  test("an abort while waiting Retry-After is rate_limited, not a timeout", async () => {
    const { adapter } = fakeC({ avail: () => xml("<Fault><Code>GDS-429</Code></Fault>", 429, { "retry-after": "1" }) });
    const err = await adapter.search(params, { signal: AbortSignal.timeout(200) }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe("rate_limited");
  });

  test("loads the tax table once for several searches", async () => {
    const { adapter, taxCalls } = fakeC({ avail: availRS });
    await Promise.all([adapter.search(params, opts()), adapter.search(params, opts())]);
    await adapter.search(params, opts());
    expect(taxCalls()).toBe(1);
  });

  test("fails if the tax table fails (no fallback to the manual's table)", async () => {
    const { adapter } = fakeC({ tax: () => fault("GDS-422", "Invalid request data"), avail: availRS });
    await expect(adapter.search(params, opts())).rejects.toThrow("GDS-422");
  });

  test("rejects an answer for other dates", async () => {
    const { adapter } = fakeC({
      avail: () => xml(`<HotelAvailRS destination="CUN" checkin="2026-12-02" checkout="2026-12-05" currency="USD" count="0"></HotelAvailRS>`),
    });
    await expect(adapter.search(params, opts())).rejects.toThrow("other dates");
  });
});
