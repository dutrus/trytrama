import { describe, expect, test } from "bun:test";
import { compareNames, distanceMeters, nameTokens, splitAddress } from "./normalize.ts";

const A = (name: string) => ({ provider: "A" as const, name });
const B = (name: string) => ({ provider: "B" as const, name });
const C = (name: string) => ({ provider: "C" as const, name });

describe("nameTokens", () => {
  test("folds accents and case, drops punctuation, expands C abbreviations", () => {
    expect(nameTokens("Lodge Lago Gutiérrez")).toEqual(["lodge", "lago", "gutierrez"]);
    expect(nameTokens("RST & SPA PENINSULA")).toEqual(["resort", "spa", "peninsula"]);
    expect(nameTokens("BTQ HTL LOS COIHUES")).toEqual(["boutique", "hotel", "los", "coihues"]);
    expect(nameTokens("WINE LDG LUJAN DE CUYO")).toEqual(["wine", "lodge", "lujan", "de", "cuyo"]);
  });

  test("strips a city suffix only for known destinations", () => {
    expect(nameTokens("Boutique Hotel Los Coihues - Bariloche")).toEqual(["boutique", "hotel", "los", "coihues"]);
    expect(nameTokens("Hotel Mar - Florianopolis")).toEqual(["hotel", "mar"]);
    expect(nameTokens("Hotel Sol - Playa")).toEqual(["hotel", "sol", "playa"]);
  });
});

describe("compareNames", () => {
  test("exact ignores word order, abbreviations and city suffix", () => {
    expect(compareNames(A("Apart Campanario"), B("Campanario Apart"))).toBe("exact");
    expect(compareNames(B("Boutique Hotel Los Coihues - Bariloche"), C("BTQ HTL LOS COIHUES"))).toBe("exact");
    expect(compareNames(A("Cabañas Cerro Otto"), C("CAB CERRO OTTO"))).toBe("exact");
  });

  test("the type is part of the name", () => {
    expect(compareNames(A("Hotel Colonia Suiza"), C("CAB COLONIA SUIZA"))).toBe("none");
  });

  test("tolerates a C name truncated at 24 characters", () => {
    expect(compareNames(C("RST & SPA PARQUE SAN MAR"), A("Resort & Spa Parque San Martín"))).toBe("tolerant");
    expect(compareNames(B("Chacras de Coria Resort & Spa"), C("RST & SPA CHACRAS DE COR"))).toBe("tolerant");
  });

  test("no tolerance for short C names or other providers", () => {
    // 21 chars: C did not cut it, so the missing word is a real difference.
    expect(compareNames(C("RST & SPA PARQUE SAN"), A("Resort & Spa Parque San Martín"))).toBe("none");
    expect(compareNames(A("Resort & Spa Parque San Mar"), B("Resort & Spa Parque San Martín"))).toBe("none");
  });

  test("truncation still needs the other words to be there", () => {
    expect(compareNames(C("RST & SPA PARQUE SAN MAR"), A("Resort Parque San Martín Sur"))).toBe("none");
  });
});

describe("splitAddress", () => {
  test("same street and number across providers' formats", () => {
    expect(splitAddress("Av. Bustillo 1744")).toEqual(splitAddress("AV. BUSTILLO 1744"));
    expect(splitAddress("Av. Arístides Villanueva 463")).toEqual({ street: "av aristides villanueva", number: "463" });
    expect(splitAddress("Avenida Bustillo 1744")).toEqual(splitAddress("Av. Bustillo 1744"));
    expect(splitAddress("Blvd. Kukulcán km 579")).toEqual({ street: "blvd kukulcan km", number: "579" });
  });

  test("an address without a trailing number has no number", () => {
    expect(splitAddress("Ruta 40 s/n")).toEqual({ street: "ruta 40 s/n", number: null });
  });
});

describe("distanceMeters", () => {
  test("measures short distances", () => {
    const d = distanceMeters({ lat: -41.1345, lng: -71.2945 }, { lat: -41.1345, lng: -71.2935 });
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(90);
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });
});
