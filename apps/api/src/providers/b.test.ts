/**
 * Provider B adapter against a local fake that speaks B's format.
 * We don't import providers/: the fake only serves canned responses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { TtlCache } from "../cache.ts";
import { PartialResultError, type SearchParams } from "../types.ts";
import { createProviderB, parseArs, parseStars } from "./b.ts";

const params: SearchParams = {
  destination: "bariloche",
  checkIn: "2026-12-01",
  checkOut: "2026-12-05",
  adults: 2,
  children: 0,
};

const busqueda = { ciudad_id: 1, fecha_ingreso: "01/12/2026", fecha_egreso: "05/12/2026", adultos: 2, menores: 0 };

// biome-ignore lint/suspicious/noExplicitAny: test fixtures in B's untyped JSON
const room = (tarifa: Record<string, any> = {}, extra: Record<string, any> = {}) => ({
  codigo_habitacion: "DBL",
  descripcion: "Doble estándar",
  regimen: "desayuno",
  capacidad_max: 2,
  tarifa: { moneda: "ARS", precio_total: "1.000.000,00", impuestos_incluidos: true, politica: "reembolsable", ...tarifa },
  ...extra,
});

// biome-ignore lint/suspicious/noExplicitAny: test fixtures in B's untyped JSON
const hotel = (id: number, extra: Record<string, any> = {}) => ({
  id_hotel: id,
  nombre: `Apart Catedral ${id} - Bariloche`,
  categoria: "4*",
  ubicacion: { direccion: "Elflein 160", ciudad: "San Carlos de Bariloche", coordenadas: { lat: "-41.1667", lon: "-71.3643" } },
  habitaciones: [room()],
  ...extra,
});

// biome-ignore lint/suspicious/noExplicitAny: test fixtures in B's untyped JSON
const page = (hoteles: any[], cursor?: string) => ({
  estado: "ok",
  data: { busqueda, hoteles },
  paginacion: { ...(cursor ? { siguiente_cursor: cursor } : {}), total_aproximado: hoteles.length },
});

const fx = (tipo_cambio = "1.000,00") => ({
  estado: "ok",
  data: { moneda_origen: "USD", moneda_destino: "ARS", tipo_cambio, fecha: "28/10/2026" },
});

/** Never answers until the client gives up. */
const hang = (req: Request) =>
  new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 }))));

type Handler = (req: Request, n: number) => Response | Promise<Response>;
type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Routes /cotizacion and /disponibilidad to handlers; records each search URL. */
function fakeB(handlers: { fx?: Handler; pages: Handler }, config: Parameters<typeof createProviderB>[0] = {}) {
  const searches: URL[] = [];
  let fxCalls = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v2/cotizacion") return (handlers.fx ?? (() => Response.json(fx())))(req, ++fxCalls);
      searches.push(url);
      return handlers.pages(req, searches.length);
    },
  });
  servers.push(server);
  const adapter = createProviderB({ baseUrl: server.url.href, hedgeMs: 5000, fxCache: new TtlCache(), ...config });
  return { adapter, searches, fxCalls: () => fxCalls };
}

const opts = () => ({ signal: new AbortController().signal });

describe("parseArs", () => {
  test("parses Argentine number format", () => {
    expect(parseArs("1.234.567,89")).toBe(1234567.89);
    expect(parseArs("939.074,67")).toBe(939074.67);
    expect(parseArs("0,50")).toBe(0.5);
  });

  test("rejects anything else", () => {
    for (const bad of ["1,234,567.89", "1234567,89", "1.234", "", "abc", 1234]) expect(parseArs(bad)).toBeNull();
  });
});

describe("parseStars", () => {
  test("reads both formats; Boutique has no stars", () => {
    expect(parseStars("4*")).toBe(4);
    expect(parseStars("3 estrellas")).toBe(3);
    expect(parseStars("Boutique")).toBeNull();
    expect(parseStars(undefined)).toBeNull();
  });
});

describe("provider B adapter", () => {
  test("parses into the common format and converts ARS to USD", async () => {
    const { adapter, searches } = fakeB({ pages: () => Response.json(page([hotel(80355)])) });
    const [h] = await adapter.search(params, opts());

    expect(h).toEqual({
      provider: "B",
      providerHotelId: "80355",
      name: "Apart Catedral 80355 - Bariloche",
      stars: 4,
      address: "Elflein 160",
      coords: { lat: -41.1667, lng: -71.3643 },
      offers: [{ provider: "B", roomType: "DBL", roomName: "Doble estándar", board: "BB", capacity: 2, refundable: true, totalUsd: 1000 }],
    });
    const q = searches[0]!.searchParams;
    expect(q.get("ciudad_id")).toBe("1");
    expect(q.get("fecha_ingreso")).toBe("01/12/2026");
    expect(q.get("fecha_egreso")).toBe("05/12/2026");
    expect(q.get("adultos")).toBe("2");
    expect(q.get("limite")).toBe("50");
  });

  test("adds impuestos when impuestos_incluidos is false", async () => {
    const r = room({ precio_total: "800.000,00", impuestos_incluidos: false, impuestos: "168.000,50" });
    const { adapter } = fakeB(
      { fx: () => Response.json(fx("1.200,00")), pages: () => Response.json(page([hotel(1, { habitaciones: [r] })])) },
    );
    const [h] = await adapter.search(params, opts());
    expect(h!.offers[0]!.totalUsd).toBe(806.67); // 968000.50 / 1200
  });

  test("maps regimen, politica, Boutique and missing coordinates", async () => {
    const rooms = [
      room({ politica: "no_reembolsable" }, { regimen: "solo_alojamiento" }),
      room({ politica: "otra" }, { regimen: "todo_incluido" }),
      room({}, { regimen: "media_pension" }),
      room({}, { regimen: "pension_completa" }),
      room({}, { regimen: "desconocido" }),
    ];
    const h = hotel(1, { categoria: "Boutique", ubicacion: { direccion: "Moreno 1", coordenadas: null }, habitaciones: rooms });
    const { adapter } = fakeB({ pages: () => Response.json(page([h])) });
    const [out] = await adapter.search(params, opts());

    expect(out!.stars).toBeNull();
    expect(out!.coords).toBeNull();
    expect(out!.offers.map((o) => [o.board, o.refundable])).toEqual([
      ["RO", false],
      ["AI", null],
      ["HB", true],
      ["FB", true],
    ]);
  });

  test("follows the cursor and merges pages", async () => {
    const { adapter, searches } = fakeB({
      pages: (_req, n) => Response.json(n === 1 ? page([hotel(1), hotel(2)], "next-1") : page([hotel(3)])),
    });
    const hotels = await adapter.search(params, opts());
    expect(hotels.map((h) => h.providerHotelId)).toEqual(["1", "2", "3"]);
    expect(searches).toHaveLength(2);
    expect(searches[0]!.searchParams.get("cursor")).toBeNull();
    expect(searches[1]!.searchParams.get("cursor")).toBe("next-1");
    expect(searches[1]!.searchParams.get("fecha_ingreso")).toBe("01/12/2026");
  });

  test("a failed later page returns what arrived as a PartialResultError", async () => {
    const { adapter } = fakeB({
      pages: (_req, n) =>
        n === 1
          ? Response.json(page([hotel(1)], "next-1"))
          : Response.json({ estado: "error", codigo: "CURSOR_INVALIDO" }, { status: 400 }),
    });
    const err = await adapter.search(params, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(PartialResultError);
    expect((err as PartialResultError).hotels.map((h) => h.providerHotelId)).toEqual(["1"]);
    expect(String((err as PartialResultError).cause)).toContain("CURSOR_INVALIDO");
  });

  test("an abort between pages also keeps the first page", async () => {
    const controller = new AbortController();
    const { adapter } = fakeB({
      pages: (req, n) => {
        if (n === 1) return Response.json(page([hotel(1)], "next-1"));
        controller.abort(new Error("search deadline"));
        return hang(req);
      },
    });
    const err = await adapter.search(params, { signal: controller.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialResultError);
    expect((err as PartialResultError).hotels).toHaveLength(1);
  });

  test("a failed first page is a plain error", async () => {
    const { adapter } = fakeB({
      pages: () => Response.json({ estado: "error", codigo: "PARAMETROS_INVALIDOS" }, { status: 400 }),
    });
    const err = await adapter.search(params, opts()).catch((e) => e);
    expect(err).not.toBeInstanceOf(PartialResultError);
    expect(String(err)).toContain("PARAMETROS_INVALIDOS");
  });

  test("rejects an answer for other dates", async () => {
    const wrong = { ...page([hotel(1)]), data: { busqueda: { ...busqueda, fecha_ingreso: "12/01/2026" }, hoteles: [hotel(1)] } };
    const { adapter } = fakeB({ pages: () => Response.json(wrong) });
    await expect(adapter.search(params, opts())).rejects.toThrow("other dates");
  });

  test("hedges a request that never answers and reports the retry", async () => {
    const { adapter, searches } = fakeB(
      { pages: (req, n) => (n === 1 ? hang(req) : Response.json(page([hotel(1)]))) },
      { hedgeMs: 50 },
    );
    const retries: { attempt: number; reason: string }[] = [];
    const hotels = await adapter.search(params, { ...opts(), onRetry: (r) => retries.push(r) });
    expect(hotels).toHaveLength(1);
    expect(searches).toHaveLength(2);
    expect(retries).toEqual([{ attempt: 2, reason: "no response after 50 ms" }]);
  });

  test("does not hedge a fast failure", async () => {
    const { adapter, searches } = fakeB(
      { pages: () => Response.json({ estado: "error", codigo: "PARAMETROS_INVALIDOS" }, { status: 400 }) },
      { hedgeMs: 50 },
    );
    await expect(adapter.search(params, opts())).rejects.toThrow();
    await Bun.sleep(80);
    expect(searches).toHaveLength(1);
  });

  test("aborting one search does not fail others waiting on the same exchange-rate load", async () => {
    const { adapter, fxCalls } = fakeB({
      fx: async () => {
        await Bun.sleep(150);
        return Response.json(fx());
      },
      pages: () => Response.json(page([hotel(1)])),
    });
    const quitter = new AbortController();
    const first = adapter.search(params, { signal: quitter.signal });
    const second = adapter.search(params, opts());
    setTimeout(() => quitter.abort(new Error("search deadline")), 50);

    await expect(first).rejects.toThrow("search deadline");
    expect(await second).toHaveLength(1);
    expect(fxCalls()).toBe(1);
  });

  test("the exchange-rate load gives up on its own timeout", async () => {
    const { adapter } = fakeB(
      { fx: (req) => hang(req), pages: () => Response.json(page([hotel(1)])) },
      { fxTimeoutMs: 100 },
    );
    const err = await adapter.search(params, opts()).catch((e) => e);
    expect((err as Error).name).toBe("TimeoutError");
  });

  test("caches the exchange rate until the UTC day changes", async () => {
    let now = Date.UTC(2026, 9, 28, 23, 0);
    const { adapter, fxCalls } = fakeB(
      { pages: () => Response.json(page([hotel(1)])) },
      { now: () => now, fxCache: new TtlCache(() => now) },
    );
    await adapter.search(params, opts());
    await adapter.search(params, opts());
    expect(fxCalls()).toBe(1);
    now = Date.UTC(2026, 9, 29, 0, 0);
    await adapter.search(params, opts());
    expect(fxCalls()).toBe(2);
  });
});
