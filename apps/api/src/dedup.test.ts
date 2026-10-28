/**
 * Dedup with hotels taken from the real providers' answers (names, addresses,
 * stars and coordinates as each provider sends them).
 */
import { describe, expect, test } from "bun:test";
import { Deduper } from "./dedup.ts";
import type { Coords, ProviderHotel, ProviderId } from "./types.ts";

function hotel(provider: ProviderId, id: string, name: string, address: string, stars: number | null, coords: Coords | null = null): ProviderHotel {
  return {
    provider,
    providerHotelId: id,
    name,
    stars,
    address,
    coords,
    offers: [{ provider, roomType: "DBL", roomName: "DBL", board: "BB", capacity: 2, refundable: true, totalUsd: 100 }],
  };
}

const run = (...batches: ProviderHotel[][]) => {
  const d = new Deduper();
  const events = batches.flatMap((b) => d.add(b));
  return { events, hotels: d.hotels() };
};

const cerroOttoGeo = { lat: -41.1345, lng: -71.2945 };
const coihuesGeo = { lat: -41.1715, lng: -71.2601 };
const parqueGeo = { lat: -32.8385, lng: -68.8327 };

describe("Deduper: merges", () => {
  test("same hotel from A and C: a hotel event, then an offer event", () => {
    const { events, hotels } = run(
      [hotel("A", "AW-10002", "Cabañas Cerro Otto", "Elflein 1597", 4, cerroOttoGeo)],
      [hotel("C", "BRC00009", "CAB CERRO OTTO", "ELFLEIN 1597", 4)],
    );
    expect(events.map((e) => e.type)).toEqual(["hotel", "offer"]);
    expect(events[1]).toMatchObject({ type: "offer", hotelId: "A-AW-10002", provider: "C" });
    expect(hotels).toHaveLength(1);
    expect(hotels[0]!.sources.map((s) => s.provider)).toEqual(["A", "C"]);
    expect(hotels[0]!.offers).toHaveLength(2);
    expect(hotels[0]!.matchNote).toBeUndefined();
  });

  test("word order does not matter", () => {
    const { hotels } = run(
      [hotel("A", "AW-10157", "Apart Campanario", "Av. Bustillo 2011", 4, { lat: -41.1612, lng: -71.3492 })],
      [hotel("B", "80400", "Campanario Apart", "Av. Bustillo 2011", 4, { lat: -41.1612, lng: -71.3492 })],
    );
    expect(hotels).toHaveLength(1);
  });

  test("exact name and address are enough without stars or coordinates to compare (Lago Gutiérrez, A and B)", () => {
    const { hotels } = run(
      [hotel("A", "AW-10024", "Lodge Lago Gutiérrez", "Av. Bustillo 917", null, { lat: -41.1757, lng: -71.3549 })],
      [hotel("B", "80222", "Lago Gutiérrez Lodge", "Av. Bustillo 917", 3)],
    );
    expect(hotels).toHaveLength(1);
  });

  test("exact name and address are enough without A (Los Coihues, B and C)", () => {
    const { hotels } = run(
      [hotel("B", "80355", "Boutique Hotel Los Coihues - Bariloche", "Elflein 1567", null, coihuesGeo)],
      [hotel("C", "BRC00012", "BTQ HTL LOS COIHUES", "ELFLEIN 1567", 4)],
    );
    expect(hotels).toHaveLength(1);
  });

  test("a C name truncated at 24 chars merges when stars confirm it", () => {
    const { hotels } = run(
      [hotel("A", "AW-10500", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", 3, parqueGeo)],
      [hotel("C", "MDZ00021", "RST & SPA PARQUE SAN MAR", "AV. ARISTIDES VILLANUEVA 463", 3)],
    );
    expect(hotels).toHaveLength(1);
  });

  test("compares with every source of a merged hotel", () => {
    // B has no stars and C no coordinates; B merges through A's coordinates.
    const { hotels } = run(
      [hotel("A", "AW-10041", "Boutique Hotel Los Coihues", "Elflein 1567", 4, coihuesGeo)],
      [hotel("C", "BRC00012", "BTQ HTL LOS COIHUES", "ELFLEIN 1567", 4)],
      [hotel("B", "80355", "Boutique Hotel Los Coihues - Bariloche", "Elflein 1567", null, coihuesGeo)],
    );
    expect(hotels).toHaveLength(1);
    expect(hotels[0]!.sources.map((s) => s.provider)).toEqual(["A", "C", "B"]);
  });

  test("the hotel event is a snapshot; later offers arrive as offer events", () => {
    const { events } = run(
      [hotel("A", "AW-10002", "Cabañas Cerro Otto", "Elflein 1597", 4, cerroOttoGeo)],
      [hotel("C", "BRC00009", "CAB CERRO OTTO", "ELFLEIN 1597", 4)],
    );
    const first = events[0]!;
    expect(first.type === "hotel" && first.hotel.offers).toHaveLength(1);
  });
});

describe("Deduper: kept apart", () => {
  test("same core name but other type and address: apart, without a note (Colonia Suiza, A and C)", () => {
    const { hotels } = run(
      [hotel("A", "AW-10266", "Hotel Colonia Suiza", "Moreno 233", 5, { lat: -41.1103, lng: -71.2837 })],
      [hotel("C", "BRC00030", "CAB COLONIA SUIZA", "AV. DE LOS PIONEROS 682", 5)],
    );
    expect(hotels).toHaveLength(2);
    expect(hotels[1]!.matchNote).toBeUndefined();
  });

  test("same address, other name and far coordinates (Cancún, Blvd. Kukulcán km 579)", () => {
    const { hotels } = run(
      [hotel("A", "AW-11134", "Grand Resort Isla Mujeres", "Blvd. Kukulcán km 579", 4, { lat: 21.173439, lng: -86.867106 })],
      [hotel("B", "83100", "Grand Resort Zona Hotelera", "Blvd. Kukulcán km 579", 4, { lat: 21.1831, lng: -86.8528 })],
      [hotel("C", "CUN00012", "GRAND RST ZONA HOTELERA", "BLVD. KUKULCAN KM 579", 4)],
    );
    expect(hotels.map((h) => h.sources.map((s) => s.provider).join("+"))).toEqual(["A", "B+C"]);
    expect(hotels[1]!.matchNote).toBe("Misma dirección que «Grand Resort Isla Mujeres» (A-AW-11134) con otro nombre; se muestra aparte.");
  });

  test("same name and number on another street stays apart", () => {
    const { hotels } = run(
      [hotel("A", "AW-1", "Hotel Catedral", "Av. Bustillo 1744", 3)],
      [hotel("B", "1", "Hotel Catedral", "Mitre 1744", 3)],
    );
    expect(hotels).toHaveLength(2);
  });

  test("stars that differ block the merge", () => {
    const { hotels } = run(
      [hotel("A", "AW-1", "Hotel Catedral", "Av. Bustillo 1744", 3)],
      [hotel("B", "1", "Hotel Catedral - Bariloche", "Av. Bustillo 1744", 4)],
    );
    expect(hotels).toHaveLength(2);
    expect(hotels[1]!.matchNote).toBe("Mismo nombre y dirección que «Hotel Catedral» (A-AW-1), pero las estrellas no coinciden; se muestra aparte.");
  });

  test("coordinates more than 150 m apart block the merge", () => {
    const { hotels } = run(
      [hotel("A", "AW-1", "Hotel Catedral", "Av. Bustillo 1744", 3, { lat: -41.1265, lng: -71.2786 })],
      [hotel("B", "1", "Hotel Catedral", "Av. Bustillo 1744", 3, { lat: -41.1285, lng: -71.2786 })],
    );
    expect(hotels).toHaveLength(2);
    expect(hotels[1]!.matchNote).toMatch(/las coordenadas están a 22\d m/);
  });

  test("a contradiction with any source of a merged hotel blocks the merge", () => {
    const { hotels } = run(
      [hotel("A", "AW-10002", "Cabañas Cerro Otto", "Elflein 1597", 4, cerroOttoGeo)],
      [hotel("C", "BRC00009", "CAB CERRO OTTO", "ELFLEIN 1597", 4)],
      [hotel("B", "80001", "Cerro Otto Cabañas", "Elflein 1597", 3)],
    );
    expect(hotels).toHaveLength(2);
  });

  test("a truncated C name without stars or coordinates to confirm it stays apart", () => {
    const { hotels } = run(
      [hotel("B", "80700", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", null, parqueGeo)],
      [hotel("C", "MDZ00021", "RST & SPA PARQUE SAN MAR", "AV. ARISTIDES VILLANUEVA 463", 3)],
    );
    expect(hotels).toHaveLength(2);
    expect(hotels[1]!.matchNote).toBe(
      "Nombre parecido y misma dirección que «Resort & Spa Parque San Martín» (B-80700), pero no hay estrellas ni coordenadas para confirmarlo; se muestra aparte.",
    );
  });

  test("a C hotel without a valid category can only merge on an exact name", () => {
    // C never has coordinates, so without stars a tolerant name has nothing to confirm it.
    const truncated = run(
      [hotel("A", "AW-10500", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", 3, parqueGeo)],
      [hotel("C", "MDZ00021", "RST & SPA PARQUE SAN MAR", "AV. ARISTIDES VILLANUEVA 463", null)],
    );
    expect(truncated.hotels).toHaveLength(2);
    expect(truncated.hotels[1]!.matchNote).toContain("no hay estrellas ni coordenadas");

    const exact = run(
      [hotel("A", "AW-10002", "Cabañas Cerro Otto", "Elflein 1597", 4, cerroOttoGeo)],
      [hotel("C", "BRC00009", "CAB CERRO OTTO", "ELFLEIN 1597", null)],
    );
    expect(exact.hotels).toHaveLength(1);
  });

  test("never merges two hotels of the same provider", () => {
    const { hotels } = run([
      hotel("A", "AW-1", "Hotel Catedral", "Av. Bustillo 1744", 3),
      hotel("A", "AW-2", "Hotel Catedral", "Av. Bustillo 1744", 3),
    ]);
    expect(hotels).toHaveLength(2);
  });
});

describe("Deduper: arrival order", () => {
  test("the same three in the usual order merge into one", () => {
    const { hotels } = run(
      [hotel("A", "AW-10500", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", 3, parqueGeo)],
      [hotel("B", "80700", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", null, parqueGeo)],
      [hotel("C", "MDZ00021", "RST & SPA PARQUE SAN MAR", "AV. ARISTIDES VILLANUEVA 463", 3)],
    );
    expect(hotels).toHaveLength(1);
  });
});

/** Constructed cases (not in the providers' data) where dedup is knowingly wrong. */
describe("Deduper: known limitations", () => {
  test("the same address written differently leaves the hotel duplicated", () => {
    const { hotels } = run(
      [hotel("A", "AW-1", "Hotel Llao Llao", "Av. Bustillo km 8,5", 5, { lat: -41.05, lng: -71.53 })],
      [hotel("B", "1", "Hotel Llao Llao", "Av. Bustillo 8500", 5, { lat: -41.05, lng: -71.53 })],
    );
    expect(hotels).toHaveLength(2);
    expect(hotels[1]!.matchNote).toBeUndefined();
  });

  test("a name with extra words does not merge", () => {
    const { hotels } = run(
      [hotel("A", "AW-1", "Panamericano Hotel", "San Martín 536", 5, { lat: -41.1335, lng: -71.3103 })],
      [hotel("B", "1", "Panamericano Hotel & Spa", "San Martín 536", 5, { lat: -41.1335, lng: -71.3103 })],
    );
    expect(hotels).toHaveLength(2);
    expect(hotels[1]!.matchNote).toBe("Misma dirección que «Panamericano Hotel» (A-AW-1) con otro nombre; se muestra aparte.");
  });

  test("two different hotels with the same name and address merge when nothing contradicts it", () => {
    // The costly error: an exact name and address need no reinforcement, so if
    // B sends no stars or coordinates, nothing can tell these two apart.
    const { hotels } = run(
      [hotel("A", "AW-1", "Hotel Central", "Mitre 100", 3, { lat: -41.1335, lng: -71.3103 })],
      [hotel("B", "1", "Hotel Central", "Mitre 100", null)],
    );
    expect(hotels).toHaveLength(1);
    expect(hotels[0]!.sources.map((s) => s.provider)).toEqual(["A", "B"]);
  });

  test("B and C first without matching each other, then A matches both: a tie, A stays apart", () => {
    // B (no stars) and C (truncated name, no coordinates) have nothing to confirm each other.
    // A matches B on exact name + coordinates, and C on tolerant name + stars: two candidates.
    const { events, hotels } = run(
      [hotel("B", "80700", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", null, parqueGeo)],
      [hotel("C", "MDZ00021", "RST & SPA PARQUE SAN MAR", "AV. ARISTIDES VILLANUEVA 463", 3)],
      [hotel("A", "AW-10500", "Resort & Spa Parque San Martín", "Av. Arístides Villanueva 463", 3, parqueGeo)],
    );
    expect(events.map((e) => e.type)).toEqual(["hotel", "hotel", "hotel"]);
    expect(hotels).toHaveLength(3);
    expect(hotels[2]!.matchNote).toBe(
      "Coincide con varios hoteles ya mostrados («Resort & Spa Parque San Martín» (B-80700), «RST & SPA PARQUE SAN MAR» (C-MDZ00021)); no se unió con ninguno para no elegir mal.",
    );
  });
});
