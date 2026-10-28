/**
 * Command-line agent:
 *
 *   bun agent "Bariloche, 4 nights from July 10, 2 adults, with breakfast"
 *
 * Answers the first message and, in a terminal, keeps the conversation going
 * until an empty line or Ctrl+C. All the logic lives in agent.ts; this file
 * only reads input and prints.
 *
 * Everything goes to stdout: on Windows terminals, writes to stdout and stderr
 * can reach the screen out of order. A readline exists only while asking, so
 * nothing redraws the prompt in the middle of an answer.
 */
import { createInterface } from "node:readline/promises";
import { type AgentDeps, newConversation, providersFooter, runTurn } from "./agent.ts";
import { createGemini, LlmError } from "./llm.ts";
import { SearchApiError, searchHotels } from "./searchTool.ts";

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = color(2);
const yellow = color(33);
const red = color(31);
const out = (s: string) => process.stdout.write(s);

const deps: AgentDeps = {
  llm: createGemini(),
  now: new Date(),
  search: (args) => searchHotels(args, { onProgress: (m) => out(dim(`  · ${m}\n`)) }),
  onText: out,
  onNotice: (m) => out(`\n${yellow(`⚠ ${m}`)}\n`),
  onModelCall: () => out(dim("  · Pensando…\n")),
  onModelWait: ({ status, waitMs }) => out(dim(`  · Gemini ocupado (${status}), reintento en ${Math.ceil(waitMs / 1000)} s…\n`)),
};

const state = newConversation();

/** One turn; on failure prints a clear message and rolls the history back. Returns false if it failed. */
async function turn(message: string): Promise<boolean> {
  const before = state.history.length;
  try {
    const result = await runTurn(state, message, deps);
    out("\n");
    if (result.searched && state.lastResult) out(`${dim(providersFooter(state.lastResult))}\n`);
    return true;
  } catch (err) {
    state.history.length = before;
    if (err instanceof LlmError || err instanceof SearchApiError) {
      out(`\n${red(err.message)}\n`);
      return false;
    }
    throw err;
  }
}

/** Asks for one line; null on Ctrl+C or end of input. The readline is closed again before returning. */
function ask(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
    rl.question("> ").then(
      (line) => {
        answered = true;
        rl.close();
        resolve(line);
      },
      () => resolve(null),
    );
  });
}

const first = process.argv.slice(2).join(" ").trim();

if (!process.stdin.isTTY) {
  // Piped input: every line is one more message of the same conversation.
  const piped = (await Bun.stdin.text()).split("\n").map((l) => l.trim());
  const messages = [first, ...piped].filter(Boolean);
  if (messages.length === 0) {
    console.error('Uso: bun agent "<qué está buscando la agente>"');
    process.exit(1);
  }
  let ok = true;
  for (const [i, m] of messages.entries()) {
    if (i > 0 || !first) out(`\n> ${m}\n`);
    ok = (await turn(m)) && ok;
  }
  process.exit(ok ? 0 : 1);
}

if (first) await turn(first);
out(dim("(Escribí para seguir la conversación; línea vacía para salir.)\n"));
for (;;) {
  out("\n");
  const line = (await ask())?.trim();
  if (!line) break;
  await turn(line);
}
process.exit(0);
