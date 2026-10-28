/**
 * The agent's core, without terminal I/O: one turn of model -> tool -> model,
 * and a conversation built on top. The model's messages stay in the history
 * exactly as received (Gemini's thoughtSignature); only older search results
 * are compacted.
 */
import { checkGrounding, type GroundingReport } from "./grounding.ts";
import type { Content, Llm, Part } from "./llm.ts";
import { systemPrompt } from "./prompt.ts";
import { type SearchResult, searchHotelsDeclaration, type ToolOutcome } from "./searchTool.ts";

/** Tool calls allowed in one turn, so a confused model cannot loop forever. */
const MAX_TOOL_ROUNDS = 3;

export interface AgentDeps {
  llm: Llm;
  search: (args: Record<string, unknown>) => Promise<ToolOutcome>;
  now: Date;
  onText?: (text: string) => void;
  /** Things the user should see that are not the model's answer (verification, correction). */
  onNotice?: (message: string) => void;
}

export interface ConversationState {
  history: Content[];
  /** The latest search result, which answers are checked against. */
  lastResult: SearchResult | null;
}

export interface TurnResult {
  /** Everything the model said this turn (correction included). */
  text: string;
  /** Whether this turn ran a search. */
  searched: boolean;
  grounding: GroundingReport;
}

export const newConversation = (): ConversationState => ({ history: [], lastResult: null });

export async function runTurn(state: ConversationState, message: string, deps: AgentDeps): Promise<TurnResult> {
  state.history.push({ role: "user", parts: [{ text: message }] });
  const answer = await respond(state, deps);
  let text = answer.text;
  let grounding = checkGrounding(text, state.lastResult);

  if (!grounding.ok) {
    deps.onNotice?.(`Verificación: ${describeProblems(grounding)}. Pido una corrección.`);
    state.history.push({ role: "user", parts: [{ text: correctionRequest(grounding) }] });
    const corrected = await respond(state, deps);
    text = corrected.text;
    grounding = checkGrounding(text, state.lastResult);
    if (!grounding.ok) deps.onNotice?.(`Verificación: la corrección todavía ${describeProblems(grounding)}. Revisá esos datos antes de pasarlos.`);
  }
  return { text, searched: answer.searched, grounding };
}

/** Model -> tool -> model until the model answers without calling a tool. */
async function respond(state: ConversationState, deps: AgentDeps): Promise<{ text: string; searched: boolean }> {
  let text = "";
  let searched = false;
  for (let round = 0; ; round++) {
    const parts = await deps.llm.generate(
      { system: systemPrompt(deps.now), contents: state.history, tools: [searchHotelsDeclaration] },
      (t) => {
        text += t;
        deps.onText?.(t);
      },
    );
    state.history.push({ role: "model", parts });

    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) return { text, searched };

    const responses: Part[] = [];
    for (const { functionCall } of calls) {
      const { name, args = {}, id } = functionCall!;
      let response: Record<string, unknown>;
      if (name !== searchHotelsDeclaration.name) {
        response = { error: `Herramienta desconocida: ${name}` };
      } else if (round >= MAX_TOOL_ROUNDS) {
        response = { error: "Se alcanzó el máximo de búsquedas para este pedido. Respondé con lo que ya tenés." };
      } else {
        const outcome = await deps.search(args);
        searched = true;
        if (outcome.ok) {
          compactOldResults(state.history);
          state.lastResult = outcome.result;
          response = { result: outcome.result };
        } else {
          response = { error: outcome.error };
        }
      }
      responses.push({ functionResponse: { name, response, ...(id ? { id } : {}) } });
    }
    state.history.push({ role: "user", parts: responses });
  }
}

/** Replaces earlier search results in the history with a one-line summary. Model parts are never touched. */
export function compactOldResults(history: Content[]): void {
  for (const content of history) {
    for (const part of content.parts) {
      const result = part.functionResponse?.response.result as SearchResult | undefined;
      if (part.functionResponse?.name !== searchHotelsDeclaration.name || !result) continue;
      const s = result.search;
      part.functionResponse.response = {
        summary: `Búsqueda anterior (${s.destination}, ${s.checkIn} a ${s.checkOut}, ${s.adults} adultos): ${result.hotels.length} hoteles. Ya no vale: usá solo la búsqueda más reciente.`,
      };
    }
  }
}

function describeProblems(g: GroundingReport): string {
  const items = [
    ...g.unknownPrices.map((p) => `el precio ${p}`),
    ...g.unknownHotels.map((h) => `el hotel "${h}"`),
  ];
  const problems: string[] = [];
  if (items.length) problems.push(`menciona ${items.join(", ")}, que no figura en la búsqueda`);
  if (g.unmentionedMissing.length) problems.push(`no dice que ${g.unmentionedMissing.join(" y ")} no respondió del todo`);
  return problems.join("; ");
}

function correctionRequest(g: GroundingReport): string {
  return `Verificación automática: tu respuesta ${describeProblems(g)}. Reescribí la respuesta usando solo hoteles y precios del último resultado de search_hotels, tal cual figuran, y avisando qué proveedores faltaron.`;
}

/** The provider status line, generated in code so it never depends on the model. */
export function providersFooter(result: SearchResult): string {
  const label = (id: string) => {
    const p = result.providers[id]!;
    if (p.status === "ok") return `${id} ok (${p.hotels} hoteles)`;
    if (p.status === "partial") return `${id} respondió en parte (${p.hotels} hoteles, ${p.reason === "timeout" ? "se cortó por tiempo" : "falló una página"})`;
    if (p.status === "timeout") return `${id} no respondió a tiempo`;
    if (p.status === "rate_limited") return `${id} sin respuesta (límite de pedidos)`;
    return `${id} con error`;
  };
  const line = `Proveedores: ${Object.keys(result.providers).sort().map(label).join(" · ")}`;
  return result.cached ? `${line}\nResultado de caché: los precios pueden tener hasta 90 segundos.` : line;
}

/** Runs a fixed list of user messages, one turn each (for tests and evals). */
export async function runConversation(messages: string[], deps: AgentDeps): Promise<{ state: ConversationState; turns: TurnResult[] }> {
  const state = newConversation();
  const turns: TurnResult[] = [];
  for (const m of messages) turns.push(await runTurn(state, m, deps));
  return { state, turns };
}
