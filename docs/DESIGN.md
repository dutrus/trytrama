# Design

<!-- 1–3 pages. Bullets are fine. Tell us what you decided, why, and which alternatives you discarded.
     A simple diagram of how a search flows (Mermaid or ASCII) is welcome but optional. -->

## Schema and events

<!-- What is a "hotel" and what is an "offer" in your model? How do you represent price, currency,
     taxes, board type, cancellation/refundability?
     What events does /search stream, and what does a client do with each one? -->

## Deduplication

<!-- How do you decide that two results are the same hotel, when they arrive at different times?
     Include at least one concrete example where it gets it wrong. -->

## Boundaries / adapters

<!-- Where does "the provider" end and "your domain" begin? What does an adapter do and not do?
     What would it take to add a fourth provider? -->

## Latency, streaming and caching

<!-- How do you get the first event out fast with providers that take 3 s? When do you send `done`?
     What do you cache, for how long, and how stale can a price be?
     Paste your `bun run load` results. -->

## Failures

<!-- Timeouts, retries, rate limits, weird responses. What does the client see when a provider fails? -->

## Agent

<!-- Which LLM/model and why. What does the search tool return to the model (and what doesn't it)?
     How does it stay grounded? What does it do with partial results and missing information?
     How did you test it? -->

## What I left out

<!-- What you'd do with more time, what production would need, debt you took on deliberately. -->

## AI usage

<!-- Short summary: what you used it for, where it helped, where it got things wrong and how you noticed.
     Details go in AI_LOG.md. -->
