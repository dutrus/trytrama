/**
 * The agent's core with a scripted fake model and a fake search: no network.
 */
import { describe, expect, test } from "bun:test";
import { type AgentDeps, newConversation, providersFooter, runConversation, runTurn } from "./agent.ts";
import type { Llm, LlmRequest, Part } from "./llm.ts";
import { describeToday, systemPrompt } from "./prompt.ts";
import type { SearchResult, ToolOutcome } from "./searchTool.ts";

const NOW = new Date("2026-10-28T15:00:00Z");

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  search: { destination: "bariloche", checkIn: "2026-12-01", checkOut: "2026-12-05", adults: 2, children: 0 },
  cached: false,
  complete: true,
  missing: [],
  providers: { A: { status: "ok", hotels: 1 }, B: { status: "ok", hotels: 1 }, C: { status: "ok", hotels: 0 } },
  hotels: [
    {
      id: "A-1",
      name: "Cabañas Cerro Otto",
      stars: 4,
      offers: [{ priceUsd: 753.04, room: "Doble twin", board: "desayuno", refundable: true, provider: "C" }],
      moreOffers: 0,
    },
  ],
  ...overrides,
});

/** Each model turn is a list of parts; text parts are streamed through onText. */
function scriptedLlm(turns: Part[][]) {
  const requests: LlmRequest[] = [];
  const llm: Llm = {
    async generate(req, onText) {
      requests.push(structuredClone(req));
      const parts = turns[requests.length - 1];
      if (!parts) throw new Error(`unexpected model call #${requests.length}`);
      for (const p of parts) if (p.text && !p.thought) onText(p.text);
      return parts;
    },
  };
  return { llm, requests };
}

function deps(llm: Llm, outcomes: ToolOutcome[] = []) {
  const searches: Record<string, unknown>[] = [];
  const streamed: string[] = [];
  const notices: string[] = [];
  const d: AgentDeps = {
    llm,
    now: NOW,
    search: async (args) => {
      searches.push(args);
      return outcomes[searches.length - 1] ?? { ok: true, result: result() };
    },
    onText: (t) => streamed.push(t),
    onNotice: (m) => notices.push(m),
  };
  return { d, searches, streamed, notices };
}

const searchCall = (args: Record<string, unknown>): Part => ({
  functionCall: { name: "search_hotels", args, id: "call-1" },
  thoughtSignature: "SIG-abc==",
});
const args = { destination: "bariloche", checkIn: "2026-12-01", checkOut: "2026-12-05", adults: 2 };

describe("prompt", () => {
  test("includes today's date and weekday in Argentina", () => {
    expect(describeToday(NOW)).toBe("miércoles 28 de octubre de 2026 (2026-10-28)");
    expect(systemPrompt(NOW)).toContain("Hoy es miércoles 28 de octubre de 2026 (2026-10-28)");
  });
});

describe("runTurn", () => {
  test("searches, sends the result back and streams a grounded answer", async () => {
    const { llm, requests } = scriptedLlm([
      [{ text: "Busco…" }, searchCall(args)],
      [{ text: "Te recomiendo Cabañas Cerro Otto por USD 753,04." }],
    ]);
    const { d, searches, streamed } = deps(llm);
    const state = newConversation();
    const turn = await runTurn(state, "Bariloche del 1 al 5 de diciembre, 2 adultos", d);

    expect(searches).toEqual([args]);
    expect(streamed.join("")).toBe("Busco…Te recomiendo Cabañas Cerro Otto por USD 753,04.");
    expect(turn).toMatchObject({ searched: true, grounding: { ok: true } });
    expect(state.lastResult).toEqual(result());

    // The second model call sees the model's own turn unchanged and the tool's answer.
    const sent = requests[1]!.contents;
    expect(sent[1]).toEqual({ role: "model", parts: [{ text: "Busco…" }, searchCall(args)] });
    expect(sent[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "search_hotels", id: "call-1", response: { result: result() } } }],
    });
    expect(requests[0]!.tools[0]!.name).toBe("search_hotels");
  });

  test("with dates missing it asks once and does not search", async () => {
    const { llm } = scriptedLlm([[{ text: "¿Para qué fechas y cuántas personas?" }]]);
    const { d, searches } = deps(llm);
    const turn = await runTurn(newConversation(), "Hoteles en Bariloche", d);
    expect(searches).toEqual([]);
    expect(turn).toMatchObject({ searched: false, text: "¿Para qué fechas y cuántas personas?", grounding: { ok: true } });
  });

  test("a tool error (bad parameters) goes back to the model", async () => {
    const { llm, requests } = scriptedLlm([[searchCall({ ...args, checkOut: "2026-11-30" })], [{ text: "La fecha de salida es anterior a la de entrada." }]]);
    const { d } = deps(llm, [{ ok: false, error: "Búsqueda rechazada: checkOut must be after checkIn" }]);
    await runTurn(newConversation(), "…", d);
    expect(requests[1]!.contents[2]!.parts[0]!.functionResponse!.response).toEqual({ error: "Búsqueda rechazada: checkOut must be after checkIn" });
  });

  test("an answer that fails verification gets one correction", async () => {
    const { llm, requests } = scriptedLlm([
      [searchCall(args)],
      [{ text: "Cabañas Cerro Otto por USD 699." }],
      [{ text: "Cabañas Cerro Otto por USD 753,04." }],
    ]);
    const { d, notices } = deps(llm);
    const turn = await runTurn(newConversation(), "…", d);
    expect(notices).toEqual(["Verificación: menciona el precio USD 699, que no figura en la búsqueda. Pido una corrección."]);
    expect(requests[2]!.contents.at(-1)!.parts[0]!.text).toContain("Verificación automática");
    expect(turn.grounding.ok).toBe(true);
    expect(turn.text).toBe("Cabañas Cerro Otto por USD 753,04.");
  });

  test("a model that keeps calling the tool is stopped", async () => {
    const { llm, requests } = scriptedLlm([[searchCall(args)], [searchCall(args)], [searchCall(args)], [searchCall(args)], [{ text: "Listo." }]]);
    const { d, searches } = deps(llm);
    await runTurn(newConversation(), "…", d);
    expect(searches).toHaveLength(3);
    expect(requests[4]!.contents.at(-1)!.parts[0]!.functionResponse!.response.error).toContain("máximo de búsquedas");
  });
});

describe("runConversation", () => {
  test("a fixed list of messages: asks for dates, then searches; history keeps the model's parts whole", async () => {
    const asked: Part[] = [{ text: "¿Qué fechas?", thoughtSignature: "SIG-1" }];
    const { llm, requests } = scriptedLlm([asked, [searchCall(args)], [{ text: "Cabañas Cerro Otto, USD 753,04." }]]);
    const { d, searches } = deps(llm);
    const { state, turns } = await runConversation(["Bariloche, 2 adultos", "Del 1 al 5 de diciembre"], d);

    expect(turns.map((t) => t.searched)).toEqual([false, true]);
    expect(searches).toEqual([args]);
    expect(requests[1]!.contents.slice(0, 3)).toEqual([
      { role: "user", parts: [{ text: "Bariloche, 2 adultos" }] },
      { role: "model", parts: asked },
      { role: "user", parts: [{ text: "Del 1 al 5 de diciembre" }] },
    ]);
    expect(state.history).toHaveLength(6);
  });

  test("an older search result is compacted; the model's parts are not", async () => {
    const second = result({ search: { ...result().search, destination: "salta" } });
    const { llm } = scriptedLlm([
      [searchCall(args)],
      [{ text: "Cabañas Cerro Otto, USD 753,04." }],
      [searchCall({ ...args, destination: "salta" })],
      [{ text: "Cabañas Cerro Otto, USD 753,04." }],
    ]);
    const { d } = deps(llm, [
      { ok: true, result: result() },
      { ok: true, result: second },
    ]);
    const { state } = await runConversation(["Bariloche…", "¿Y en Salta?"], d);

    const responses = state.history.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    expect(responses[0]!.functionResponse!.response).toEqual({
      summary: "Búsqueda anterior (bariloche, 2026-12-01 a 2026-12-05, 2 adultos): 1 hoteles. Ya no vale: usá solo la búsqueda más reciente.",
    });
    expect(responses[1]!.functionResponse!.response).toEqual({ result: second });
    expect(state.history.filter((c) => c.role === "model").flatMap((c) => c.parts).filter((p) => p.thoughtSignature)).toHaveLength(2);
    expect(state.lastResult).toBe(second);
  });
});

describe("providersFooter", () => {
  test("says which providers answered, in code", () => {
    const r = result({
      cached: true,
      missing: ["B", "C"],
      providers: {
        C: { status: "timeout", hotels: 0 },
        A: { status: "ok", hotels: 20 },
        B: { status: "partial", hotels: 12, reason: "timeout" },
      },
    });
    expect(providersFooter(r)).toBe(
      "Proveedores: A ok (20 hoteles) · B respondió en parte (12 hoteles, se cortó por tiempo) · C no respondió a tiempo\nResultado de caché: los precios pueden tener hasta 90 segundos.",
    );
  });
});
