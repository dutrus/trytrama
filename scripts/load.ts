/**
 * Simple load test against YOUR streaming search API.
 *
 *   bun run load                       # 200 searches, 10 concurrent
 *   bun run load --requests 500 --concurrency 25
 *
 * Calls GET {API_URL}/search?destination=&checkIn=&checkOut=&adults=
 * with a realistic mix: a few popular searches repeat a lot, many are one-offs.
 *
 * The response must be Server-Sent Events (text/event-stream) and end with an
 * `event: done`. For each search it measures:
 *   - first event: time until the first SSE event arrives
 *   - done:        time until `event: done` arrives
 * Target: first event p95 < 800 ms, errors <= 1%.
 */
import { hash32, mulberry32 } from "@mocks/kit";

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
}

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const TOTAL = flag("requests", 200);
const CONCURRENCY = flag("concurrency", 10);
const TIMEOUT_MS = flag("timeout", 15_000);
const TARGET_P95 = flag("target-p95", 800);
const MAX_ERROR_RATE = flag("max-error-rate", 0.01);
const rand = mulberry32(hash32(process.env.LOAD_SEED ?? "load"));

const DESTINATIONS = ["bariloche", "mendoza", "salta", "florianopolis", "cancun"];

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function randomSearch(): string {
  const destination = DESTINATIONS[Math.floor(rand() * DESTINATIONS.length)];
  const start = 14 + Math.floor(rand() * 120);
  const nights = 2 + Math.floor(rand() * 6);
  const adults = 1 + Math.floor(rand() * 3);
  return `/search?destination=${destination}&checkIn=${isoDay(start)}&checkOut=${isoDay(start + nights)}&adults=${adults}`;
}

// ~60% of traffic goes to 10 "hot" searches, the rest is long tail.
const hot = Array.from({ length: 10 }, randomSearch);
const paths = Array.from({ length: TOTAL }, () => (rand() < 0.6 ? (hot[Math.floor(rand() * hot.length)] as string) : randomSearch()));

interface Result {
  firstMs: number | null;
  doneMs: number | null;
  events: number;
  error: string | null;
}

/** Reads an SSE stream until `event: done`. Comment lines (":") don't count as events. */
async function hit(path: string): Promise<Result> {
  const t0 = performance.now();
  const result: Result = { firstMs: null, doneMs: null, events: 0, error: null };
  try {
    const res = await fetch(API_URL + path, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ...result, error: String(res.status) };
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return { ...result, error: "not-sse" };
    if (!res.body) return { ...result, error: "no-body" };

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let eventName = "";
    let eventHasFields = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (line === "") {
          if (eventHasFields) {
            result.events++;
            result.firstMs ??= performance.now() - t0;
            if (eventName === "done") {
              result.doneMs = performance.now() - t0;
              await reader.cancel();
              return result;
            }
          }
          eventName = "";
          eventHasFields = false;
        } else if (!line.startsWith(":")) {
          eventHasFields = true;
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
        }
      }
    }
    return { ...result, error: "no-done" };
  } catch (err) {
    return { ...result, error: (err as Error).name === "TimeoutError" ? "timeout" : "network" };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

const health = await fetch(`${API_URL}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`API not reachable at ${API_URL}/health. Is \`bun dev\` running?`);
  process.exit(1);
}

console.log(`Load: ${TOTAL} searches, concurrency ${CONCURRENCY}, against ${API_URL}`);
const results: Result[] = [];
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < paths.length) {
      const path = paths[next++] as string;
      results.push(await hit(path));
      if (results.length % 50 === 0) process.stdout.write(`  ${results.length}/${TOTAL}\n`);
    }
  }),
);
const elapsed = (performance.now() - started) / 1000;

const ok = results.filter((r) => r.error === null);
const first = ok.map((r) => r.firstMs as number).sort((a, b) => a - b);
const done = ok.map((r) => r.doneMs as number).sort((a, b) => a - b);
const errors = results.filter((r) => r.error !== null);
const byError = new Map<string, number>();
for (const r of errors) byError.set(r.error as string, (byError.get(r.error as string) ?? 0) + 1);
const errorRate = errors.length / results.length;
const p95First = percentile(first, 95);
const avgEvents = ok.length ? ok.reduce((s, r) => s + r.events, 0) / ok.length : 0;

const fmt = (n: number) => `${Math.round(n)} ms`.padEnd(9);
console.log(`
  searches     ${results.length} in ${elapsed.toFixed(1)}s (${(results.length / elapsed).toFixed(1)} req/s)

               first event   done
  p50          ${fmt(percentile(first, 50))}     ${fmt(percentile(done, 50))}
  p95          ${fmt(p95First)}     ${fmt(percentile(done, 95))}
  p99          ${fmt(percentile(first, 99))}     ${fmt(percentile(done, 99))}

  events/search  ${avgEvents.toFixed(1)} avg
  error rate     ${(errorRate * 100).toFixed(2)}%   (target <= ${(MAX_ERROR_RATE * 100).toFixed(0)}%)${byError.size ? `  ${[...byError].map(([s, n]) => `${s}: ${n}`).join(", ")}` : ""}
`);

const firstOk = ok.length > 0 && p95First < TARGET_P95;
const errorsOk = errorRate <= MAX_ERROR_RATE;
console.log(firstOk ? `  ✅ first event p95 under ${TARGET_P95} ms` : `  ❌ first event p95 over ${TARGET_P95} ms`);
console.log(errorsOk ? "  ✅ error rate under target" : "  ❌ error rate over target");
process.exit(firstOk && errorsOk ? 0 : 1);
