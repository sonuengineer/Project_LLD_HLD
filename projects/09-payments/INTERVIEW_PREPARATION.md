# Interview Preparation -- Payment System

Question bank: `interview/data/p09-payments/` (validated), browsable in the portfolio website.

## Stories

1. **Idempotency end to end** -- client keys, provider keys, webhook dedupe, ledger idempotency refs.
2. **Timeout = unknown** -- tok_slow: the provider charged, we timed out; same-key retry or recovery resolves it.
3. **Ledger invariants in the database** -- deferred constraint trigger + append-only trigger; trial balance 0.
4. **Concurrency** -- CAS transitions, one capture, pending refunds counted to prevent over-refund.
5. **Safety nets** -- webhooks, recovery worker, daily reconciliation; saga with compensations instead of 2PC.
