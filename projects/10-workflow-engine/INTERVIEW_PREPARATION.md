# Interview Preparation -- flowengine

Question bank: `interview/data/p10-workflow-engine/` (validated), browsable in the portfolio website.

## Stories

1. **Durable execution explained with code** -- event history + replay; crash a worker, another resumes.
2. **Determinism** -- event-order replay, races, non-determinism detection that blocks instead of failing.
3. **Activities done right** -- retries/backoff, non-retryable errors, heartbeat leases, idempotency keys.
4. **Saga as plain code** -- compensations guaranteed by durability.
5. **Bugs and measurements** -- four engine bugs found by tests; replay cost vs history length; CPU-bound single process vs scaling with processes.
