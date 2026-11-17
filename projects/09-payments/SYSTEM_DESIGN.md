# System Design -- Payment System

## Principles

1. **Never lose money, never double charge.** Prefer "unknown" over guessing; resolve unknowns by asking
   the source of truth (the provider).
2. **Idempotency end to end.** Client -> us (Idempotency-Key), us -> provider (deterministic keys from our ids),
   provider -> us (event id dedupe), ledger (one posting per business event).
3. **No DB transaction spans a network call.** Short transactions around the provider call; intermediate
   states make "in flight" visible and recoverable.
4. **The ledger is the financial truth**, derived balances only, invariants enforced by the database.

## Distributed transactions: why not 2PC

The provider is a third party: it won't join our database transaction. Two-phase commit across services is
also blocking and fragile. Instead:
- **Single service + external call**: intent state -> call with idempotency key -> record result; recovery
  for the gap (this is a mini saga with the provider as one participant).
- **Multi-service business process** (checkout): an orchestrated **saga** with persisted steps and
  compensations (refund, release inventory). Results are eventually consistent: between steps the world is
  partially updated, and compensations are themselves business operations (a refund is visible to the customer).

## Consistency model

| Data | Consistency |
|---|---|
| payment status + ledger posting | atomic (same transaction) |
| our status vs provider status | eventually consistent (webhooks, recovery, reconciliation) |
| saga (inventory + payment + shipping) | eventually consistent with compensations |
| balances | always derived from entries (no drift between "balance" and history) |

## Scaling path

| Scale | Change |
|---|---|
| 10x | stateless API replicas; recovery worker with `SKIP LOCKED` batches; partition `payment_events`/`ledger_entries` by month |
| 100x | ledger per currency/region shards; hot accounts (platform fee) via sub-accounts or batched postings; outbox -> Kafka for events; read models for dashboards |
| Multi-provider | routing by cost/success rate; per-provider circuit breakers; provider-agnostic reconciliation |
