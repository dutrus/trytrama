# Assignment

## Context

Trama is the platform travel agencies and small travel retailers in LATAM use to sell trips.
A sales agent at an agency in Neuquén is chatting with a client on WhatsApp who wants
"Bariloche, 4 nights, 2 adults". The agent needs to see **every option from every one of our
providers, in a single list, fast**, and more and more they'd rather just ask for it in plain words.

Today we have three hotel providers (A, B and C in this repo). Each one speaks its own
language, has its own latency and fails in its own way. Some answer in 300 ms, some take 3 s.

You'll build two things:

1. A **streaming search API** that unifies the providers.
2. A small **agent** that uses that API to answer a travel agent's request in natural language.

## 1. Streaming search API (`apps/api`)

```
GET /search?destination=<destination>&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adults=N[&children=N]
```

`destination` is one of: `bariloche`, `mendoza`, `salta`, `florianopolis`, `cancun`.

The response is a stream of **Server-Sent Events** (`Content-Type: text/event-stream`). Results
should reach the client as providers answer, not when the slowest one finishes. The only fixed
part of the contract is that the stream **ends with an event named `done`**:

```
event: done
data: {...anything you want...}
```

Everything else (event names, payloads, how a hotel is updated when another provider returns
it too) is your design. We expect the results to:

1. **Be unified** across A, B and C in a single format.
2. **Be deduplicated**: the same hotel can show up in several providers with different names or
   data. The client should see each hotel once, with the offers from each provider, even though
   those offers arrive at different times.
3. **Have comparable prices**: same currency (USD) and same basis (total for the stay, taxes included).
4. **Be resilient**: if a provider is slow or down, the stream still delivers what's available and
   makes clear what's missing.
5. **Be fast**: `bun run load` with first-event p95 **< 800 ms** and error rate <= 1%. It also
   reports time to `done`; there's no fixed target for that one, but tell us how you chose it.

## 2. Agent (`apps/agent`)

A command-line agent:

```bash
bun agent "Bariloche, 4 nights from July 10, 2 adults, with breakfast"
```

It should:

1. **Turn a natural-language request** (Spanish or English) into a search. When something is
   missing or ambiguous (no dates, "next weekend"), ask or state its assumptions.
2. **Use your `/search` API over HTTP** as a tool. It doesn't talk to the providers directly.
3. **Stream its answer** to the terminal while results arrive, instead of waiting silently.
4. **Stay grounded**: only mention hotels and prices that came from the search, and say when a
   provider didn't answer.

Use any LLM provider and model, with your own API key. Tell us which one and why in `DESIGN.md`.
A small model is fine; the expected cost is a few dollars at most. If you can't use a paid LLM
API, tell us before starting.

No UI, auth, database, durable persistence or deploy needed.

## What a good submission looks like

**We expect:**

- `/search` streaming and passing CI. If you don't hit the latency target, tell us why and what you'd do.
- An agent you can run with one command, plus 2–3 example runs pasted in the PR.
- A `docs/DESIGN.md` of **1–3 pages**: what you decided, why, and which alternatives you discarded.
  Include real numbers from `bun run load`, and **at least one concrete example where your dedup
  gets it wrong**. A simple diagram of how a search flows (Mermaid or ASCII) is welcome but optional.
- Tests where the risk is: provider parsing, dedup, failure handling. `CHAOS_SEED` helps make them
  reproducible. Coverage for its own sake doesn't matter.
- Commits that show how you got there, and an honest `AI_LOG.md`.

**We don't expect:** a UI, Docker, deploy, perfect deduplication, 100% coverage, polished diagrams
or long documents. Something smaller and well reasoned beats something big and fragile.

**Priorities, if you run out of time:**

- **Must:** the streaming API (points 1, 3, 4, 5) and an agent that is grounded and streams.
- **We look at your judgment, not perfection:** deduplication, and how the agent handles
  ambiguity. A perfect dedup is not possible with this data; tell us what it gets wrong.
- **Nice to have:** fancier caching, request coalescing, metrics, agent conversation memory.
  Mention them in `DESIGN.md` and we'll discuss them live.

Suggested time: **about 6 hours**. If you go over, stop and write down what you'd do next. That counts in your favor.

## What to deliver

A **pull request against `main`** in this repo (fill in the PR template) containing:

- Your code in `apps/api` and `apps/agent` (with the tests you think matter).
- A completed [`docs/DESIGN.md`](DESIGN.md).
- [`AI_LOG.md`](../AI_LOG.md): using AI is allowed and expected; we want to see how you use it.

## After you submit

We'll review your PR and then do a live session together (~90 min): you walk us through your
solution and we extend it together. Use whatever tools you normally use, AI included.

## What we'll look at

- Design decisions and why (including what you left out).
- How you modeled the domain and where you drew the boundaries between your system and the providers.
- How you handle latency, streaming and failures.
- How the agent uses the search: what it gives the model, how it stays grounded, how it handles partial results.
- How easy your design is to extend.
- Code and test quality, without over-engineering.
