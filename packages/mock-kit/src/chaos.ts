/**
 * Chaos: latency, errors and timeouts, configured via env vars.
 *
 * With CHAOS_SEED set, every decision is a pure function of
 * (seed, provider, request key, attempt number). Same requests in the same
 * order-per-key => same outcomes, regardless of concurrency. A retry of the
 * same request is a new attempt, so it gets a new (but still deterministic) roll.
 */
import { hash32, mulberry32 } from "./rng.ts";

export interface ChaosConfig {
  enabled: boolean;
  seed: string | null;
  latencyMs: [number, number];
  /** Probability of an error response (provider-specific: 500, SOAP fault, failed job...). */
  errorRate: number;
  /** Probability of never answering. */
  timeoutRate: number;
}

export interface ChaosRoll {
  attempt: number;
  latencyMs: number;
  error: boolean;
  timeout: boolean;
  /** Extra deterministic randomness for provider-specific decisions. */
  rand: () => number;
}

type Env = Record<string, string | undefined>;

export function parseRange(raw: string | undefined, fallback: [number, number]): [number, number] {
  if (!raw) return fallback;
  const [a, b] = raw.split("-").map((s) => Number(s.trim()));
  if (a === undefined || Number.isNaN(a)) return fallback;
  const max = b === undefined || Number.isNaN(b) ? a : b;
  return [Math.min(a, max), Math.max(a, max)];
}

export function parseRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : fallback;
}

/**
 * Reads PROVIDER_<X>_LATENCY_MS ("min-max"), PROVIDER_<X>_ERROR_RATE,
 * PROVIDER_<X>_TIMEOUT_RATE, plus global CHAOS=off and CHAOS_SEED.
 */
export function chaosFromEnv(
  prefix: string,
  defaults: Omit<ChaosConfig, "enabled" | "seed">,
  env: Env = process.env,
): ChaosConfig {
  const enabled = !["off", "0", "false"].includes((env.CHAOS ?? "on").toLowerCase());
  return {
    enabled,
    seed: env.CHAOS_SEED || null,
    latencyMs: parseRange(env[`${prefix}_LATENCY_MS`], defaults.latencyMs),
    errorRate: parseRate(env[`${prefix}_ERROR_RATE`], defaults.errorRate),
    timeoutRate: parseRate(env[`${prefix}_TIMEOUT_RATE`], defaults.timeoutRate),
  };
}

export class Chaos {
  private attempts = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly config: ChaosConfig,
  ) {}

  roll(key: string): ChaosRoll {
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const rand =
      this.config.seed === null ? Math.random : mulberry32(hash32(`${this.config.seed}|${this.name}|${key}|${attempt}`));

    if (!this.config.enabled) return { attempt, latencyMs: 0, error: false, timeout: false, rand };

    const [min, max] = this.config.latencyMs;
    const latencyMs = Math.round(min + rand() * (max - min));
    const u = rand();
    const error = u < this.config.errorRate;
    const timeout = !error && u < this.config.errorRate + this.config.timeoutRate;
    return { attempt, latencyMs, error, timeout, rand };
  }

  reset(): void {
    this.attempts.clear();
  }
}

/** Stable key for a request: method + path + sorted query (+ body). */
export function requestKey(req: Request, body = ""): string {
  const url = new URL(req.url);
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${req.method} ${url.pathname}?${new URLSearchParams(params).toString()}#${body}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A response that never arrives. Settles only when the client gives up. */
export function hang(req: Request): Promise<Response> {
  return new Promise((resolve) => {
    req.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })));
  });
}
