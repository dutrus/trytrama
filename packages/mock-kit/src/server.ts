export interface ProviderServerOptions {
  /** Port to listen on. 0 = random (used by tests). */
  port?: number;
  /** Override env vars (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  quiet?: boolean;
}

const COLORS: Record<string, string> = { A: "\x1b[36m", B: "\x1b[35m", C: "\x1b[33m", D: "\x1b[32m" };

export function logger(tag: string, quiet = false) {
  const color = COLORS[tag] ?? "";
  return (req: Request, status: number | string, startedAt: number, note = "") => {
    if (quiet || process.env.LOG === "off") return;
    const ms = Math.round(performance.now() - startedAt);
    const path = new URL(req.url).pathname;
    console.log(`${color}[${tag}]\x1b[0m ${req.method} ${path} -> ${status} ${ms}ms${note ? ` (${note})` : ""}`);
  };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}
