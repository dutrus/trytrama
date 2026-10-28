/**
 * Fixed cases against the real model (needs GEMINI_API_KEY; not part of bun test).
 * Today's date is fixed so relative dates are reproducible.
 *
 *   bun apps/agent/src/evals.ts
 *
 * Cases 1-3 use the real /search API (bun dev must be running). Case 4 uses a
 * fixed result where B did not answer, so it does not depend on chaos.
 */
import { type AgentDeps, newConversation, runTurn } from "./agent.ts";
import { createGemini, type Llm } from "./llm.ts";
import { type SearchResult, searchHotels, type ToolOutcome } from "./searchTool.ts";

const NOW = new Date("2026-10-28T15:00:00Z"); // Wednesday

const bDown: SearchResult = {
  search: { destination: "mendoza", checkIn: "2026-12-01", checkOut: "2026-12-04", adults: 2, children: 0 },
  cached: false,
  complete: false,
  missing: ["B"],
  providers: { A: { status: "ok", hotels: 2 }, B: { status: "timeout", hotels: 0 }, C: { status: "ok", hotels: 1 } },
  hotels: [
    {
      id: "A-AW-10371",
      name: "Posada Las Heras",
      stars: 3,
      offers: [{ priceUsd: 412.5, room: "Doble", board: "desayuno", refundable: true, provider: "A" }],
      moreOffers: 0,
    },
    {
      id: "A-AW-10380",
      name: "Wine Lodge Malbec",
      stars: 5,
      offers: [{ priceUsd: 1290.75, room: "Suite", board: "desayuno", refundable: false, provider: "A" }],
      moreOffers: 0,
    },
    {
      id: "C-MDZ00006",
      name: "HTL ALAMEDA",
      stars: 2,
      offers: [{ priceUsd: 268.2, room: "Doble", board: "solo alojamiento", refundable: true, provider: "C" }],
      moreOffers: 0,
    },
  ],
};

interface Case {
  name: string;
  message: string;
  search?: (args: Record<string, unknown>) => Promise<ToolOutcome>;
  check: (run: Run) => string[];
}

interface Run {
  searches: Record<string, unknown>[];
  text: string;
  groundingOk: boolean;
  notices: string[];
}

const realSearch = (args: Record<string, unknown>) => searchHotels(args, { onProgress: (m) => console.log(`  · ${m}`) });

const cases: Case[] = [
  {
    name: "1. Pedido completo",
    message: "Bariloche del 1 al 5 de diciembre, 2 adultos, con desayuno",
    check: (r) => [
      expect(r.searches.length === 1, "buscó una vez"),
      expect(
        r.searches[0]?.destination === "bariloche" && r.searches[0]?.checkIn === "2026-12-01" && r.searches[0]?.checkOut === "2026-12-05" && r.searches[0]?.adults === 2,
        "parámetros correctos (bariloche, 2026-12-01 a 2026-12-05, 2 adultos)",
      ),
      expect(r.groundingOk, "pasa la verificación"),
    ],
  },
  {
    name: "2. Sin fechas",
    message: "Necesito un hotel en Mendoza para 2 personas",
    check: (r) => [expect(r.searches.length === 0, "no buscó"), expect(r.text.includes("?"), "hizo una pregunta"), expect(/fecha/i.test(r.text), "pregunta por las fechas")],
  },
  {
    name: '3. "El finde que viene"',
    message: "Algo en Salta para el finde que viene, somos 2",
    check: (r) => [
      expect(r.searches.length === 1, "buscó una vez"),
      expect(r.searches[0]?.checkIn === "2026-10-30" && r.searches[0]?.checkOut === "2026-11-01", "viernes 30/10 a domingo 1/11"),
      expect(/30|viernes/i.test(r.text), "dice qué fechas usó"),
      expect(r.groundingOk, "pasa la verificación"),
    ],
  },
  {
    name: "4. Un proveedor caído (B no respondió)",
    message: "Mendoza del 1 al 4 de diciembre, 2 adultos",
    search: async () => ({ ok: true, result: bDown }),
    check: (r) => [expect(r.searches.length === 1, "buscó una vez"), expect(r.groundingOk, "pasa la verificación (incluye avisar que falta B)")],
  },
  {
    name: "5. Destino inexistente",
    message: "Hotel en Ushuaia del 1 al 5 de diciembre, 2 adultos",
    check: (r) => [
      expect(r.searches.length === 0, "no buscó"),
      expect(["bariloche", "mendoza", "salta", "florian", "canc"].filter((d) => r.text.toLowerCase().includes(d)).length >= 3, "nombra los destinos disponibles"),
    ],
  },
];

function expect(ok: boolean, label: string): string {
  return `${ok ? "PASA" : "FALLA"}  ${label}`;
}

async function runCase(llm: Llm, c: Case): Promise<boolean> {
  console.log(`\n=== ${c.name}\n> ${c.message}`);
  const searches: Record<string, unknown>[] = [];
  const notices: string[] = [];
  const deps: AgentDeps = {
    llm,
    now: NOW,
    search: async (args) => {
      searches.push(args);
      console.log(`  [search_hotels ${JSON.stringify(args)}]`);
      return (c.search ?? realSearch)(args);
    },
    onText: (t) => process.stdout.write(t),
    onModelWait: ({ status, waitMs }) => console.log(`  [Gemini ocupado (${status}), reintento en ${Math.ceil(waitMs / 1000)} s]`),
    onNotice: (m) => {
      notices.push(m);
      console.log(`\n⚠ ${m}`);
    },
  };
  const turn = await runTurn(newConversation(), c.message, deps);
  console.log("\n--- chequeos");
  const results = c.check({ searches, text: turn.text, groundingOk: turn.grounding.ok, notices });
  for (const r of results) console.log(r);
  if (!turn.grounding.ok) console.log(`  verificación: ${JSON.stringify(turn.grounding)}`);
  return results.every((r) => r.startsWith("PASA"));
}

const llm = createGemini();
let passed = 0;
for (const c of cases) {
  try {
    if (await runCase(llm, c)) passed++;
  } catch (err) {
    console.log(`FALLA  error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${passed} de ${cases.length} casos pasan.`);
