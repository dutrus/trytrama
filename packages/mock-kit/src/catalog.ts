/**
 * Shared "ground truth" hotel catalog. Every fake provider exposes a subset of
 * these hotels, each with its own IDs, names and formats. Fully deterministic:
 * the same CATALOG_SEED always produces the same 200 hotels.
 */
import { between, hash32, mulberry32, pick, shuffle } from "./rng.ts";

export type DestinationKey = "bariloche" | "mendoza" | "salta" | "florianopolis" | "cancun";
export type ProviderKey = "a" | "b" | "c" | "d";
export type Board = "RO" | "BB" | "HB" | "FB" | "AI";

export interface Destination {
  key: DestinationKey;
  name: string;
  country: "AR" | "BR" | "MX";
  /** City code used by LegacyGDS (C). */
  iata: string;
  /** Numeric city id used by SurBeds (B). */
  surbedsId: number;
  utcOffset: string;
  lat: number;
  lng: number;
  priceFactor: number;
  /** Real taxes. Providers A, B (mostly) and D bake these into totals. */
  taxes: { pct: number; perNightUsd: number };
  /** Price multiplier by month (1-12). Missing months = 1. */
  season: Partial<Record<number, number>>;
  types: string[];
  cores: string[];
  streets: string[];
}

export const DESTINATIONS: Destination[] = [
  {
    key: "bariloche",
    name: "San Carlos de Bariloche",
    country: "AR",
    iata: "BRC",
    surbedsId: 1,
    utcOffset: "-03:00",
    lat: -41.1335,
    lng: -71.3103,
    priceFactor: 1.1,
    taxes: { pct: 0.21, perNightUsd: 2.5 },
    season: { 1: 1.3, 2: 1.25, 7: 1.6, 8: 1.4 },
    types: ["Hotel", "Hostería", "Apart", "Cabañas", "Lodge", "Boutique Hotel", "Resort & Spa"],
    cores: [
      "Cerro Otto", "Nahuel Huapi", "Catedral", "Lago Gutiérrez", "Bahía López",
      "Los Coihues", "Playa Bonita", "Campanario", "Colonia Suiza", "Arrayanes",
      "Los Alerces", "Patagonia", "Península", "Lago Moreno", "Melipal",
    ],
    streets: ["Av. Bustillo", "Mitre", "Av. de los Pioneros", "Elflein", "Moreno"],
  },
  {
    key: "mendoza",
    name: "Mendoza",
    country: "AR",
    iata: "MDZ",
    surbedsId: 2,
    utcOffset: "-03:00",
    lat: -32.8895,
    lng: -68.8458,
    priceFactor: 0.9,
    taxes: { pct: 0.21, perNightUsd: 0 },
    season: { 1: 1.1, 3: 1.35 },
    types: ["Hotel", "Posada", "Apart", "Boutique Hotel", "Wine Lodge", "Resort & Spa"],
    cores: [
      "Aconcagua", "Malbec", "Chacras de Coria", "Luján de Cuyo", "Valle de Uco",
      "Cerro Arco", "Los Andes", "Potrerillos", "Parque San Martín", "Vendimia",
      "Maipú", "Tupungato", "Cacheuta", "Las Heras", "Alameda",
    ],
    streets: ["Av. San Martín", "Sarmiento", "Av. Arístides Villanueva", "Belgrano", "Av. Emilio Civit"],
  },
  {
    key: "salta",
    name: "Salta",
    country: "AR",
    iata: "SLA",
    surbedsId: 3,
    utcOffset: "-03:00",
    lat: -24.7821,
    lng: -65.4232,
    priceFactor: 0.75,
    taxes: { pct: 0.21, perNightUsd: 1.5 },
    season: { 1: 1.1, 7: 1.25 },
    types: ["Hotel", "Hostería", "Posada", "Boutique Hotel", "Apart", "Hostal"],
    cores: [
      "Salta la Linda", "San Bernardo", "Quebrada", "Cafayate", "Los Valles",
      "Cachi", "Güemes", "Plaza 9 de Julio", "Calchaquí", "Balcarce",
      "Lerma", "Portezuelo", "Los Cardones", "Tren a las Nubes", "Virreyes",
    ],
    streets: ["Caseros", "Balcarce", "Av. Belgrano", "España", "Alvarado"],
  },
  {
    key: "florianopolis",
    name: "Florianópolis",
    country: "BR",
    iata: "FLN",
    surbedsId: 7,
    utcOffset: "-03:00",
    lat: -27.5954,
    lng: -48.548,
    priceFactor: 1.0,
    taxes: { pct: 0.05, perNightUsd: 0 },
    season: { 1: 1.6, 2: 1.55, 7: 0.8, 12: 1.3 },
    types: ["Hotel", "Pousada", "Resort", "Flat", "Hostel"],
    cores: [
      "Jurerê", "Lagoa da Conceição", "Canasvieiras", "Ingleses", "Campeche",
      "Barra da Lagoa", "Santo Antônio", "Praia Mole", "Joaquina", "Ilha Bela",
      "Ribeirão", "Daniela", "Armação", "Pântano do Sul", "Beira Mar",
    ],
    streets: ["Rua das Gaivotas", "Av. das Rendeiras", "Rua Bocaiúva", "Av. Beira Mar Norte", "Rua Lauro Linhares"],
  },
  {
    key: "cancun",
    name: "Cancún",
    country: "MX",
    iata: "CUN",
    surbedsId: 12,
    utcOffset: "-05:00",
    lat: 21.1619,
    lng: -86.8515,
    priceFactor: 1.4,
    taxes: { pct: 0.19, perNightUsd: 4.5 },
    season: { 1: 1.35, 2: 1.4, 3: 1.45, 4: 1.3, 9: 0.85, 10: 0.85, 12: 1.4 },
    types: ["Hotel", "Resort", "Grand Resort", "Suites", "Beach Club"],
    cores: [
      "Playa Delfines", "Punta Nizuc", "Isla Mujeres", "Nichupté", "Zona Hotelera",
      "Puerto Juárez", "Playa Tortugas", "Coral Beach", "Kukulcán", "Puerto Morelos",
      "Caribe Azul", "Mar Turquesa", "Sian Ka'an", "Costa Mujeres", "Playa Langosta",
    ],
    streets: ["Blvd. Kukulcán km", "Av. Tulum", "Av. Bonampak", "Av. Cobá", "Av. Nichupté"],
  },
];

export interface RoomTemplate {
  code: "SGL" | "DBL" | "TWN" | "TPL" | "FAM" | "STE";
  name: string;
  capacity: number;
  factor: number;
  board: Board;
}

export interface Hotel {
  /** Canonical id. Internal to the mocks; providers expose their own ids. */
  id: string;
  destination: DestinationKey;
  type: string;
  core: string;
  name: string;
  stars: number;
  lat: number;
  lng: number;
  address: string;
  baseNightlyUsd: number;
  rooms: RoomTemplate[];
  /** Per-provider identifiers. Missing key = hotel not distributed by that provider. */
  ids: Partial<Record<ProviderKey, string>>;
}

const ROOM_KINDS: Omit<RoomTemplate, "board">[] = [
  { code: "SGL", name: "Single Standard", capacity: 1, factor: 0.75 },
  { code: "DBL", name: "Double Standard", capacity: 2, factor: 1 },
  { code: "TWN", name: "Twin Standard", capacity: 2, factor: 1 },
  { code: "TPL", name: "Triple", capacity: 3, factor: 1.3 },
  { code: "FAM", name: "Family Room", capacity: 4, factor: 1.6 },
  { code: "STE", name: "Suite", capacity: 2, factor: 2.1 },
];

const BASE_BY_STARS: Record<number, number> = { 2: 45, 3: 75, 4: 130, 5: 260 };
const HOTELS_PER_DESTINATION = 40;

/** Provider coverage probabilities. Overlap between providers is the point. */
const COVERAGE: Record<ProviderKey, number> = { a: 0.6, b: 0.8, c: 0.5, d: 0.45 };

function buildCatalog(seed: string): Hotel[] {
  const rand = mulberry32(hash32(`catalog|${seed}`));
  const hotels: Hotel[] = [];
  let surbedsNext = 80_100;

  for (const dest of DESTINATIONS) {
    const usedNames = new Set<string>();
    let cCounter = 1;
    for (let i = 0; i < HOTELS_PER_DESTINATION; i++) {
      let type = pick(rand, dest.types);
      const core = dest.cores[i % dest.cores.length] as string;
      while (usedNames.has(`${type} ${core}`)) type = pick(rand, dest.types);
      const name = `${type} ${core}`;
      usedNames.add(name);

      const r = rand();
      const stars = r < 0.12 ? 2 : r < 0.45 ? 3 : r < 0.82 ? 4 : 5;
      const base = (BASE_BY_STARS[stars] ?? 75) * dest.priceFactor * between(rand, 0.8, 1.25);

      const isAllInclusive = dest.key === "cancun" && /Resort|Beach Club/.test(type) && rand() < 0.8;
      const defaultBoard: Board = isAllInclusive ? "AI" : stars >= 4 ? "BB" : rand() < 0.5 ? "RO" : "BB";
      const roomCount = 1 + Math.floor(rand() * 4);
      const kinds = shuffle(rand, ROOM_KINDS).slice(0, roomCount);
      if (!kinds.some((k) => k.capacity >= 2)) kinds.push(ROOM_KINDS[1] as Omit<RoomTemplate, "board">);
      const rooms: RoomTemplate[] = kinds.map((k) => ({
        ...k,
        board: !isAllInclusive && rand() < 0.15 ? (rand() < 0.5 ? "HB" : "FB") : defaultBoard,
      }));

      const ids: Partial<Record<ProviderKey, string>> = {};
      const idx = hotels.length;
      if (rand() < COVERAGE.a) ids.a = `AW-${10_000 + idx * 7 + Math.floor(rand() * 7)}`;
      if (rand() < COVERAGE.b) ids.b = String((surbedsNext += 1 + Math.floor(rand() * 40)));
      if (rand() < COVERAGE.c) ids.c = `${dest.iata}${String(cCounter++ * 3).padStart(5, "0")}`;
      if (rand() < COVERAGE.d) ids.d = `nvp_${Math.floor(mulberry32(hash32(`${seed}|d|${idx}`))() * 2 ** 32).toString(16).padStart(8, "0")}`;
      if (Object.keys(ids).length === 0) ids.a = `AW-${10_000 + idx * 7}`;

      hotels.push({
        id: `H${String(idx + 1).padStart(3, "0")}`,
        destination: dest.key,
        type,
        core,
        name,
        stars,
        lat: round(dest.lat + between(rand, -0.06, 0.06), 6),
        lng: round(dest.lng + between(rand, -0.06, 0.06), 6),
        address: `${pick(rand, dest.streets)} ${10 + Math.floor(rand() * 2400)}`,
        baseNightlyUsd: round(base, 2),
        rooms,
        ids,
      });
    }
  }
  return hotels;
}

export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

const cache = new Map<string, Hotel[]>();

export function getCatalog(seed = process.env.CATALOG_SEED ?? "trama-2026"): Hotel[] {
  let hotels = cache.get(seed);
  if (!hotels) {
    hotels = buildCatalog(seed);
    cache.set(seed, hotels);
  }
  return hotels;
}

export function hotelsFor(provider: ProviderKey, destination: DestinationKey): Hotel[] {
  return getCatalog().filter((h) => h.destination === destination && h.ids[provider] !== undefined);
}

export function destinationBy<K extends keyof Destination>(field: K, value: Destination[K]): Destination | undefined {
  return DESTINATIONS.find((d) => d[field] === value);
}

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
