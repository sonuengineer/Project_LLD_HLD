# Trade-offs -- Distributed Job Queue

1. **Redis vs Postgres as the queue.** Redis: fast atomic scripts, sorted sets for scheduling.
   Postgres (`SELECT ... FOR UPDATE SKIP LOCKED`): transactional enqueue with business data (no dual
   write), but heavier per job and vacuum pressure. Chosen: Redis for mechanics, Postgres for effects.
   Cost: enqueue is not atomic with the producer's own DB transaction (an outbox would fix that; see
   Project 4/9).
2. **At-least-once + idempotency vs at-most-once.** Never lose a job; pay with duplicate handling in
   every handler.
3. **Polling vs push.** Adaptive polling is simple and robust; costs up to 1s idle latency and some
   empty Redis calls. BZPOPMIN or pub/sub would cut latency but complicate batch claiming.
4. **Short extended leases vs long fixed leases.** Fast crash detection (~35s) and timeouts that
   can be hours; costs lease-extension traffic and the risk that a blocked event loop (CPU-bound
   handler) misses extensions -> duplicate execution.
5. **Attempt counter as fencing token.** No extra state; works because attempts only grow (DLQ
   requeue resets it, but a zombie from before the DLQ can't hold an `active` lease any more).
6. **Full jitter backoff.** Spreads retries to avoid thundering herds; individual retries are less
   predictable.
7. **Skip missed schedule runs.** After downtime, fire once instead of a burst; jobs that need every
   slot must be designed differently (e.g. catch-up with idempotency per slot).
8. **Strict priority across queues.** Simple; can starve `low` under sustained `critical` load.
   Weighted round-robin would trade strictness for fairness.
9. **Batch claim.** Big throughput win; a worker that crashes right after claiming N jobs delays all N
   until their leases expire.
