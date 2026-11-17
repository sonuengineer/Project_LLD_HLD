# Trade-offs -- Payment System

1. **Persisted intermediate states vs one big transaction.** Crash-safe and recoverable; costs more round
   trips (26 statements per authorize+capture measured) and more states to reason about.
2. **Timeout = unknown, not failure.** Prevents "charged but no order"; requires a recovery worker and a
   `requires_reconciliation` state that clients must handle (poll / webhook).
3. **Retry with the same idempotency key.** Resolves most ambiguity immediately; relies on the provider
   honouring keys (all serious providers do, for a retention window).
4. **Ledger enforced in the database (triggers).** Bugs can't create money; costs DB-specific logic and a
   per-entry trigger at commit.
5. **Derived balances.** Always consistent with history; aggregation cost grows (production: periodic
   balance snapshots + entries since).
6. **Idempotency rows store responses.** Exact replays; storage grows (expire keys after e.g. 24h-7d).
7. **Store 4xx, not 5xx, under an idempotency key.** Deterministic errors replay; transient errors can be retried.
8. **Saga with compensations vs 2PC.** No distributed locks, works with third parties; intermediate states are
   visible (a refund appears on the customer's statement).
9. **Partial unique index for duplicate orders.** Blocks double charges per order while allowing a retry after a
   decline; requires merchants to send stable references.
10. **Mock provider as a separate service.** Realistic network failures; more moving parts in local setup.
