import { describe, expect, test } from "bun:test";
import { checkGrounding, mentionedHotels, mentionedPrices } from "./grounding.ts";
import type { SearchResult } from "./searchTool.ts";

const offer = (priceUsd: number) => ({ priceUsd, room: "Doble", board: "desayuno", refundable: true, provider: "A" });
const result: SearchResult = {
  search: { destination: "bariloche", checkIn: "2026-12-01", checkOut: "2026-12-05", adults: 2, children: 0 },
  cached: false,
  complete: false,
  missing: ["B"],
  providers: { A: { status: "ok", hotels: 3 }, B: { status: "timeout", hotels: 0 }, C: { status: "ok", hotels: 1 } },
  hotels: [
    { id: "A-1", name: "Cabañas Cerro Otto", stars: 4, offers: [offer(753.04), offer(766.1)], moreOffers: 0 },
    { id: "A-2", name: "Hotel Catedral", stars: 3, offers: [offer(660.4)], moreOffers: 0 },
    { id: "A-3", name: "Resort & Spa Parque San Martín", stars: 3, offers: [offer(1570.37)], moreOffers: 0 },
    { id: "C-9", name: "CAB COLONIA SUIZA", stars: 5, offers: [offer(1613.2)], moreOffers: 0 },
  ],
};

describe("mentionedPrices", () => {
  test("reads the usual ways of writing a USD amount", () => {
    expect(mentionedPrices("USD 766,10 · US$ 1.570 · $753.04 · 660 dólares · U$S 1,613.20").map((p) => p.value)).toEqual([
      766.1, 1570, 753.04, 660, 1613.2,
    ]);
  });

  test("ignores numbers without a currency", () => {
    expect(mentionedPrices("4 noches, 2 adultos, del 1 al 5 de diciembre de 2026")).toEqual([]);
  });
});

describe("mentionedHotels", () => {
  test("finds hotel-looking names, split by punctuation", () => {
    expect(mentionedHotels("Te recomiendo **Hotel Catedral**, Cabañas Cerro Otto y el Resort & Spa Parque San Martín.")).toEqual([
      "Hotel Catedral",
      "Cabañas Cerro Otto",
      "Resort & Spa Parque San Martín",
    ]);
  });

  test("a sentence-initial article is not part of the name", () => {
    expect(mentionedHotels("El Hotel Catedral tiene desayuno. La Cabañas Cerro Otto también.")).toEqual(["Hotel Catedral", "Cabañas Cerro Otto"]);
    expect(checkGrounding("El Hotel Catedral cuesta USD 660,40. El proveedor B no respondió.", result).ok).toBe(true);
  });

  test("ignores capitalized words that are not hotels", () => {
    expect(mentionedHotels("En Bariloche, del Lunes al Viernes. Proveedor B no respondió.")).toEqual([]);
  });
});

describe("checkGrounding", () => {
  test("an answer that only uses the result passes", () => {
    const text =
      "Encontré opciones en Bariloche: Cabañas Cerro Otto desde USD 753,04, Hotel Catedral por USD 660 y CAB COLONIA SUIZA por US$ 1.613,20. " +
      "El proveedor B no respondió a tiempo.";
    expect(checkGrounding(text, result)).toEqual({ ok: true, unknownPrices: [], unknownHotels: [], unmentionedMissing: [] });
  });

  test("flags a price that is not in the result", () => {
    const report = checkGrounding("Hotel Catedral por USD 599. El proveedor B no respondió.", result);
    expect(report.ok).toBe(false);
    expect(report.unknownPrices).toEqual(["USD 599"]);
  });

  test("flags a hotel that is not in the result", () => {
    const report = checkGrounding("Te recomiendo el Hotel Llao Llao. El proveedor B no respondió.", result);
    expect(report.unknownHotels).toEqual(["Hotel Llao Llao"]);
  });

  test("flags a missing provider the answer does not mention", () => {
    expect(checkGrounding("Hotel Catedral por USD 660,40.", result).unmentionedMissing).toEqual(["B"]);
    expect(checkGrounding("Hotel Catedral por USD 660,40. B no respondió a tiempo.", result).unmentionedMissing).toEqual([]);
  });

  test('the Spanish word "a" does not count as provider A', () => {
    const r = { ...result, missing: ["A"] };
    expect(checkGrounding("Llegué a la conclusión de que no hubo respuesta a tiempo.", r).unmentionedMissing).toEqual(["A"]);
  });

  test("with no search, any price or hotel is unknown", () => {
    const report = checkGrounding("El Hotel Catedral cuesta USD 660.", null);
    expect(report).toMatchObject({ ok: false, unknownPrices: ["USD 660"], unknownHotels: ["Hotel Catedral"] });
  });
});
