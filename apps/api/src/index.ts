/**
 * HTTP entry point: validates /search parameters and streams the search as SSE.
 * Providers are registered in the list below; nothing else knows about them.
 */
import { createProviderA } from "./providers/a.ts";
import { createProviderB } from "./providers/b.ts";
import { createProviderC } from "./providers/c.ts";
import { runSearch } from "./search.ts";
import { sseResponse } from "./sse.ts";
import { DESTINATIONS, type Destination, type ProviderAdapter, type SearchParams } from "./types.ts";

/** Time until done. Covers B's two pages (up to ~5 s); see DESIGN.md. */
const DEADLINE_MS = 5500;
const MAX_NIGHTS = 30;

export interface AppOptions {
  providers: ProviderAdapter[];
  deadlineMs: number;
}

export function createApp({ providers, deadlineMs }: AppOptions) {
  return {
    fetch(req: Request): Response {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname !== "/search" || req.method !== "GET") return Response.json({ error: "not_found" }, { status: 404 });

      const parsed = parseSearchParams(url.searchParams);
      if ("error" in parsed) return Response.json({ error: "invalid_params", message: parsed.error }, { status: 400 });

      return sseResponse(async (send, signal) => {
        await runSearch(parsed.params, providers, send, { deadlineMs, signal });
      }, req.signal);
    },
  };
}

export function parseSearchParams(q: URLSearchParams): { params: SearchParams } | { error: string } {
  const destination = (q.get("destination") ?? "").trim().toLowerCase();
  if (!DESTINATIONS.includes(destination as Destination)) {
    return { error: `destination must be one of ${DESTINATIONS.join(", ")}` };
  }

  const checkIn = q.get("checkIn") ?? "";
  const checkOut = q.get("checkOut") ?? "";
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return { error: "checkIn and checkOut must be valid YYYY-MM-DD dates" };
  const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000;
  if (nights < 1) return { error: "checkOut must be after checkIn" };
  if (nights > MAX_NIGHTS) return { error: `stays longer than ${MAX_NIGHTS} nights are not supported` };

  const adults = Number(q.get("adults") ?? "");
  if (!Number.isInteger(adults) || adults < 1 || adults > 6) return { error: "adults must be an integer from 1 to 6" };
  const children = Number(q.get("children") ?? "0");
  if (!Number.isInteger(children) || children < 0 || children > 4) return { error: "children must be an integer from 0 to 4" };

  return { params: { destination: destination as Destination, checkIn, checkOut, adults, children } };
}

/** YYYY-MM-DD and a real calendar day (rejects 2026-02-30). */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

if (import.meta.main) {
  const app = createApp({ providers: [createProviderA(), createProviderB(), createProviderC()], deadlineMs: DEADLINE_MS });
  const server = Bun.serve({ port: Number(process.env.API_PORT ?? 3000), fetch: app.fetch });
  console.log(`[API] listening on ${server.url}`);
}
