# Interview Preparation -- Collaborative Editing

Question bank: `interview/data/p08-collab/` (validated), browsable in the portfolio website.

## Stories

1. **OT proven by property tests** -- and the shrunk counterexample showing transform doesn't distribute over compose.
2. **Fuzz test found a real state-machine bug** -- offline buffer without an outstanding op.
3. **Horizontal WebSocket scaling** -- Postgres sequencer + Redis fan-out + ordered forwarder with gap fill (pub/sub is at-most-once and unordered).
4. **Exactly-once effect of edits** -- lost ack, reconnect catch-up, (client_id, client_seq) dedupe.
5. **Security of real-time endpoints** -- one-time tickets, per-message authorization, op validation.
