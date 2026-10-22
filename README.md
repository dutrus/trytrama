# Trama — Take-home: unified hotel search

This repo is the starting point for the take-home. It contains **fake travel providers**
(each with its own quirks, just like real ones) and empty skeletons where you'll build
a streaming search API that unifies them, and a small agent that uses it.

👉 **The assignment is in [`docs/CHALLENGE.md`](docs/CHALLENGE.md).** Start there.

## Requirements

- [Bun](https://bun.sh) **>= 1.2** (tested with 1.3). Nothing else: no Docker, no accounts, no databases.

```bash
bun install
bun dev
```

`bun dev` starts every provider plus your API (with hot reload). Ctrl+C stops everything.

## What's in the repo

```
apps/api/            ← YOUR streaming search API (today it only has /health)
apps/agent/          ← YOUR agent CLI (today it only prints usage)
providers/
  a/  Andes Wholesale   REST JSON, USD
  b/  SurBeds           REST JSON in Spanish, ARS, paginated
  c/  LegacyGDS         SOAP-style XML, net nightly rates
packages/mock-kit/   shared catalog and "chaos" for the fake providers
scripts/load.ts      load test against your API
docs/                assignment and design template
AI_LOG.md            AI usage log (template)
```

Each provider has its documentation in `providers/<x>/README.md`, written the way the real
provider would write it. **Treat it as third-party documentation**: it may be incomplete.

> The code in `providers/` and `packages/mock-kit/` simulates external systems. You can read it,
> but your solution must work against the providers as black boxes: don't modify it and don't
> import anything from there into `apps/api` or `apps/agent`.

## Ports

| Service                       | Port | How to start                        |
|-------------------------------|------|-------------------------------------|
| Your API (`apps/api`)         | 3000 | `bun dev` (or `bun api`)            |
| Provider A — Andes Wholesale  | 4001 | `bun dev`                           |
| Provider B — SurBeds          | 4002 | `bun dev`                           |
| Provider C — LegacyGDS        | 4003 | `bun dev`                           |

Each provider can also run on its own: `bun provider:a`, `bun provider:b`, `bun provider:c`.

## Default provider behavior

| Provider | Latency      | Failures                                 |
|----------|--------------|------------------------------------------|
| A        | 150–400 ms   | 3% HTTP 500                              |
| B        | 0.8–2.5 s    | 5% of requests never respond             |
| C        | 0.3–3 s      | 5 req/s rate limit (429 + Retry-After), some errors |

## Environment variables

Everything is configurable via env (Bun loads `.env` automatically). See [`.env.example`](.env.example) for the full list.

| Variable                        | Default      | Purpose                                                   |
|---------------------------------|--------------|-----------------------------------------------------------|
| `CHAOS`                         | `on`         | `off` disables latency, errors and timeouts on every provider. |
| `CHAOS_SEED`                    | —            | Makes chaos **deterministic**: same requests ⇒ same outcomes. Useful for reproducible tests. |
| `PROVIDER_<X>_LATENCY_MS`       | see table    | `min-max` range in ms (e.g. `0-0`, `200-800`).            |
| `PROVIDER_<X>_ERROR_RATE`       | see table    | Error probability, 0–1.                                   |
| `PROVIDER_B_TIMEOUT_RATE`       | `0.05`       | Probability, 0–1, of never responding.                    |
| `PROVIDER_C_RATE_LIMIT_RPS`     | `5`          | Requests per second (global). `0` disables it.            |
| `PROVIDER_<X>_PORT`, `API_PORT` | see ports    |                                                           |
| `LOG`                           | `on`         | `off` silences per-request provider logs.                 |

Example — develop without noise, then test with reproducible chaos:

```bash
CHAOS=off bun dev
CHAOS_SEED=42 bun dev
```

**About determinism:** with `CHAOS_SEED`, every decision (latency, error, timeout) depends on
the seed, the request (method + path + query/body) and how many times that same request has
been repeated. A retry is a new attempt and gets a new roll, but always the same roll for that
attempt number. The hotel catalog and prices are always deterministic.

## Scripts

| Command          | What it does                                                    |
|------------------|-----------------------------------------------------------------|
| `bun dev`        | All providers + your API.                                       |
| `bun api`        | Only your API, with hot reload.                                 |
| `bun agent "…"`  | Runs your agent with a request in natural language.             |
| `bun run load`   | Load test against your API (see below).                         |
| `bun test`       | Tests (the mocks' tests are already there; add yours).          |
| `bun typecheck`  | `tsc --noEmit`.                                                 |

### Load test

```bash
bun dev                     # in one terminal
bun run load                # in another: 200 requests, concurrency 10
bun run load --requests 500 --concurrency 25
```

It hits `GET http://localhost:3000/search?destination=&checkIn=&checkOut=&adults=`
(override with `API_URL`) with a realistic mix: a few popular searches repeat a lot and the
rest is long tail. The response must be Server-Sent Events ending with `event: done`.
It reports p50/p95/p99 for **time to first event** and **time to `done`**, plus error rate.
**Target: first-event p95 < 800 ms and error rate <= 1%** (adjustable with `--target-p95` and
`--max-error-rate`). Exits with code 1 if the target is missed.

## Deliverables

Open a **pull request against `main` in this repo** with your solution. Fill in the PR template.
See [`docs/CHALLENGE.md`](docs/CHALLENGE.md) for details.

CI runs `bun typecheck`, `bun test` and the load test (with `CHAOS_SEED=ci`) on every PR.
