# apps/api — your API

Your solution goes here. **Assignment: [`docs/CHALLENGE.md`](../../docs/CHALLENGE.md).**

Today there's only `src/index.ts` with a health check:

```bash
curl http://localhost:3000/health   # { "ok": true }
```

What you need to build:

- `GET /search?destination=&checkIn=&checkOut=&adults=[&children=]` that queries providers
  A, B and C, normalizes and deduplicates the results, and **streams** them as Server-Sent
  Events, ending with `event: done`. The rest of the event design is yours.
- The normalized schema, the per-provider adapters and how you handle latency and failures
  are up to you: document them in [`docs/DESIGN.md`](../../docs/DESIGN.md).

Notes:

- Talk to the providers over HTTP (`http://localhost:4001` … `4003`), as if they were third parties.
  Don't import code from `providers/` or `packages/mock-kit/`.
- You can add dependencies if you justify them, but we prefer few.
- `bun dev` runs this app with `--watch`. `bun test` runs any `*.test.ts` in the repo.
- To validate performance: `bun run load` (target: first-event p95 < 800 ms).
- Quick look at your stream: `curl -N 'http://localhost:3000/search?destination=salta&checkIn=2026-12-01&checkOut=2026-12-05&adults=2'`.
