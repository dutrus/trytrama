# apps/agent — your agent

A small command-line agent that a travel agent could use instead of filling in a search form.
**Assignment: [`docs/CHALLENGE.md`](../../docs/CHALLENGE.md).**

```bash
bun agent "Bariloche, 4 nights from July 10, 2 adults, with breakfast"
```

What it should do:

- Understand a request in natural language (Spanish or English), turn it into a search, and
  ask or state its assumptions when something is missing (e.g. no dates).
- Call **your** streaming `/search` API over HTTP, as a tool. Don't call the providers directly.
- Stream its answer to the terminal as results arrive. Don't wait silently for every provider.
- Only mention hotels and prices that came from the search. Say when a provider didn't answer.

Notes:

- Use any LLM provider and model you like, with your own API key. Tell us which one in
  `docs/DESIGN.md`. A small, cheap model is fine; expected cost is a few dollars at most.
- Any SDK is fine (or plain `fetch`). Put the key in `.env`; never commit it.
- If you can't use a paid LLM API, tell us before starting and we'll sort it out.
