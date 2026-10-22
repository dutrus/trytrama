/**
 * Provider B — "SurBeds"
 * REST + JSON, snake_case, Spanish, nested. ARS prices as "1.234.567,50"
 * strings, DD/MM/YYYY dates, cursor pagination. Slow, and sometimes it just
 * never answers.
 */
import {
  Chaos,
  type Board,
  DESTINATIONS,
  type ProviderServerOptions,
  chaosFromEnv,
  hang,
  hash32,
  hotelsFor,
  json,
  logger,
  quote,
  requestKey,
  sleep,
  stripAccents,
  unit,
  validateStay,
} from "@mocks/kit";

const PAGE_MAX = 20;

const REGIMEN: Record<Board, string> = {
  RO: "solo_alojamiento",
  BB: "desayuno",
  HB: "media_pension",
  FB: "pension_completa",
  AI: "todo_incluido",
};

const DESCRIPCION: Record<string, string> = {
  SGL: "Single estándar",
  DBL: "Doble estándar",
  TWN: "Doble twin",
  TPL: "Triple",
  FAM: "Familiar",
  STE: "Suite",
};

/** 1234567.5 -> "1.234.567,50" */
export function formatArs(n: number): string {
  const [int, dec] = n.toFixed(2).split(".");
  return `${(int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

/** DD/MM/YYYY -> YYYY-MM-DD (or "" if malformed) */
function fromDmy(s: string | null): string {
  const m = s?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

function toDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** USD -> ARS. Moves a bit every day, stable within a day. */
export function usdArsRate(isoDay: string): number {
  return 1185 + Math.round(unit("fx", isoDay) * 4000) / 100;
}

function nombre(type: string, core: string, destName: string, seed: string): string {
  const r = unit(seed, "b-name");
  if (r < 0.4) return `${type} ${core}`;
  if (r < 0.7) return `${core} ${type}`;
  return `${type} ${core} - ${stripAccents(destName.replace("San Carlos de ", ""))}`;
}

export function start(opts: ProviderServerOptions = {}) {
  const env = opts.env ?? process.env;
  const chaos = new Chaos("b", chaosFromEnv("PROVIDER_B", { latencyMs: [800, 2500], errorRate: 0, timeoutRate: 0.05 }, env));
  const log = logger("B", opts.quiet);

  const server = Bun.serve({
    port: opts.port ?? Number(env.PROVIDER_B_PORT ?? 4002),
    // "Never answers" has to really mean never: disable Bun's idle timeout.
    idleTimeout: 0,
    async fetch(req) {
      const t0 = performance.now();
      const url = new URL(req.url);
      const q = url.searchParams;

      if (url.pathname === "/health") return json({ estado: "ok" });

      if (req.method === "GET" && url.pathname === "/api/v2/ciudades") {
        return json({
          estado: "ok",
          data: DESTINATIONS.map((d) => ({ id_ciudad: d.surbedsId, nombre: d.name, pais: d.country })),
        });
      }

      const isSearch = url.pathname === "/api/v2/disponibilidad";
      const isFx = url.pathname === "/api/v2/cotizacion";
      if (req.method !== "GET" || (!isSearch && !isFx)) {
        log(req, 404, t0);
        return json({ estado: "error", codigo: "RECURSO_INEXISTENTE" }, { status: 404 });
      }

      const roll = chaos.roll(requestKey(req));
      if (roll.timeout) {
        log(req, "hang", t0, "chaos: never responds");
        return hang(req);
      }
      await sleep(roll.latencyMs);

      if (isFx) {
        const today = new Date().toISOString().slice(0, 10);
        log(req, 200, t0);
        return json({
          estado: "ok",
          data: { moneda_origen: "USD", moneda_destino: "ARS", tipo_cambio: formatArs(usdArsRate(today)), fecha: toDmy(today) },
        });
      }

      const dest = DESTINATIONS.find((d) => String(d.surbedsId) === q.get("ciudad_id"));
      const stay = {
        checkIn: fromDmy(q.get("fecha_ingreso")),
        checkOut: fromDmy(q.get("fecha_egreso")),
        adults: Number(q.get("adultos") ?? 2),
        children: Number(q.get("menores") ?? 0),
      };
      const invalid = !dest ? "ciudad_id inexistente" : validateStay(stay);
      if (invalid || !dest) {
        log(req, 400, t0);
        return json({ estado: "error", codigo: "PARAMETROS_INVALIDOS", detalle: invalid }, { status: 400 });
      }

      const queryHash = hash32(`${dest.surbedsId}|${stay.checkIn}|${stay.checkOut}|${stay.adults}|${stay.children}`);
      let offset = 0;
      const cursor = q.get("cursor");
      if (cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { o: number; h: number };
          if (parsed.h !== queryHash) throw new Error("mismatch");
          offset = parsed.o;
        } catch {
          log(req, 400, t0);
          return json({ estado: "error", codigo: "CURSOR_INVALIDO" }, { status: 400 });
        }
      }
      const limit = Math.min(Math.max(Number(q.get("limite") ?? PAGE_MAX) || PAGE_MAX, 1), PAGE_MAX);
      const rate = usdArsRate(new Date().toISOString().slice(0, 10));

      const all = hotelsFor("b", dest.key)
        .map((hotel) => ({ hotel, quotes: quote(hotel, "b", stay) }))
        .filter((x) => x.quotes.length > 0)
        // "Relevance" ordering: stable but meaningless.
        .sort((x, y) => hash32(`${x.hotel.id}|rel`) - hash32(`${y.hotel.id}|rel`));
      const page = all.slice(offset, offset + limit);

      const hoteles = page.map(({ hotel, quotes }) => {
        const taxesIncluded = unit(hotel.id, "b-tax") >= 0.15;
        const hasGeo = unit(hotel.id, "b-geo") >= 0.1;
        const boutique = hotel.type === "Boutique Hotel";
        const categoria = boutique ? "Boutique" : unit(hotel.id, "b-cat") < 0.3 ? `${hotel.stars} estrellas` : `${hotel.stars}*`;
        return {
          id_hotel: Number(hotel.ids.b),
          nombre: nombre(hotel.type, hotel.core, dest.name, hotel.id),
          categoria,
          ubicacion: {
            direccion: hotel.address,
            ciudad: dest.name,
            coordenadas: hasGeo ? { lat: hotel.lat.toFixed(4), lon: hotel.lng.toFixed(4) } : null,
          },
          habitaciones: quotes.map((qt) => {
            const net = qt.totalUsd - qt.taxesUsd;
            return {
              codigo_habitacion: qt.room.code,
              descripcion: DESCRIPCION[qt.room.code],
              regimen: REGIMEN[qt.room.board],
              capacidad_max: qt.room.capacity,
              tarifa: {
                moneda: "ARS",
                precio_total: formatArs((taxesIncluded ? qt.totalUsd : net) * rate),
                impuestos_incluidos: taxesIncluded,
                ...(taxesIncluded ? {} : { impuestos: formatArs(qt.taxesUsd * rate) }),
                politica: qt.refundable ? "reembolsable" : "no_reembolsable",
              },
            };
          }),
        };
      });

      const next = offset + limit < all.length ? Buffer.from(JSON.stringify({ o: offset + limit, h: queryHash })).toString("base64url") : undefined;
      log(req, 200, t0, `${hoteles.length} hoteles, offset ${offset}`);
      return json({
        estado: "ok",
        data: {
          busqueda: {
            ciudad_id: dest.surbedsId,
            fecha_ingreso: toDmy(stay.checkIn),
            fecha_egreso: toDmy(stay.checkOut),
            adultos: stay.adults,
            menores: stay.children,
          },
          hoteles,
        },
        paginacion: {
          ...(next ? { siguiente_cursor: next } : {}),
          total_aproximado: Math.max(0, all.length + Math.floor(unit(queryHash, "approx") * 5) - 2),
        },
      });
    },
  });

  if (!opts.quiet) console.log(`[B] SurBeds listening on ${server.url}`);
  return server;
}

if (import.meta.main) start();
