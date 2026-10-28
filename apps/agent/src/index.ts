/**
 * Command-line agent:
 *
 *   bun agent "Bariloche, 4 nights from July 10, 2 adults, with breakfast"
 *
 * Answers the first message and, in a terminal, keeps the conversation going
 * until an empty line or Ctrl+C. All the logic lives in agent.ts; this file
 * only reads input and prints.
 */
import { createInterface } from "node:readline/promises";
import { type AgentDeps, newConversation, providersFooter, runTurn } from "./agent.ts";
import { createGemini, LlmError } from "./llm.ts";
import { SearchApiError, searchHotels } from "./searchTool.ts";

const color = (code: number) => (s: string) => (process.stderr.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = color(2);
const yellow = color(33);
const red = color(31);

const deps: AgentDeps = {
  llm: createGemini(),
  now: new Date(),
  search: (args) => searchHotels(args, { onProgress: (m) => process.stderr.write(dim(`  · ${m}\n`)) }),
  onText: (t) => process.stdout.write(t),
  onNotice: (m) => process.stderr.write(`\n${yellow(`⚠ ${m}`)}\n`),
};

const state = newConversation();

/** One turn; on failure prints a clear message and rolls the history back. Returns false if it failed. */
async function turn(message: string): Promise<boolean> {
  const before = state.history.length;
  try {
    const result = await runTurn(state, message, deps);
    process.stdout.write("\n");
    if (result.searched && state.lastResult) process.stderr.write(`${dim(providersFooter(state.lastResult))}\n`);
    return true;
  } catch (err) {
    state.history.length = before;
    if (err instanceof LlmError || err instanceof SearchApiError) {
      process.stderr.write(`\n${red(err.message)}\n`);
      return false;
    }
    throw err;
  }
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
    if (i > 0 || !first) process.stderr.write(`\n> ${m}\n`);
    ok = (await turn(m)) && ok;
  }
  process.exit(ok ? 0 : 1);
}

if (first) await turn(first);

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});
process.stderr.write(dim("(Escribí para seguir la conversación; línea vacía para salir.)\n"));
for (;;) {
  const line = (await rl.question("\n> ").catch(() => "")).trim();
  if (!line) break;
  await turn(line);
}
rl.close();
