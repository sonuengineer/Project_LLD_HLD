# Project 9 -- Payment System

A payments backend built around the failure cases that matter with money: idempotency keys, a payment
state machine with persisted intermediate states, a **double-entry ledger whose invariants the database
enforces**, ambiguous provider timeouts handled as "unknown" (never as failure), a recovery worker,
signed idempotent provider webhooks, a reconciliation engine, and a checkout saga with compensations.

**Mock provider only -- never real money or real credentials.** The mock provider is a separate HTTP
service with its own schema, so timeouts and retries are real network behaviour.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Payment creation, authorization, capture (full/partial), void, refunds (partial/full) | `services/payments.py` | `test_authorize_and_capture_books_balanced_ledger`, `test_partial_capture_and_refunds` |
| Idempotency keys (replay, mismatch 422, in-progress 409, crash takeover) | `services/idempotency.py`, `api/routes.py::idempotent` | `test_idempotency_key_semantics` |
| Payment state machine (compare-and-set transitions + append-only audit trail) | `services/state.py`, `payment_events` | event timeline assertions |
| Double-entry ledger; DB-enforced balance (deferred constraint trigger) + immutability | `services/ledger.py`, migration 0001 | `test_ledger_invariants_enforced_by_database`, trial balance = 0 |
| Duplicate transaction protection (one live payment per order) | partial unique index | `test_duplicate_order_payment_blocked` |
| Concurrency: one capture, no over-refund (row locks + pending refunds counted) | `capture_payment`, `create_refund` | `test_concurrent_captures_capture_once`, `test_concurrent_refunds_cannot_over_refund` |
| Provider abstraction + mock provider (decline, insufficient funds, slow, flaky, capture failure) | `services/provider.py`, `mockprovider/app.py` | `test_declines_*`, `test_provider_flaky_500_is_retried_safely`, `test_capture_rejected_*` |
| Retry handling with same idempotency key; timeouts are ambiguous, not failures | `HttpProvider._call` | `test_timeout_retried_with_same_key_resolves_immediately`, `test_timeout_is_not_treated_as_failure_*` |
| Recovery of stuck/ambiguous states (lookup by reference; retry with same key) | `services/recovery.py`, `worker.py` | `test_crash_mid_capture_*`, `test_payment_unknown_to_provider_*` |
| Provider webhooks: signature, dedupe, out-of-order safe | `services/webhooks.py` | `test_webhooks_are_verified_deduplicated_and_can_finalize_capture` |
| Reconciliation engine (matched / missing / amount / status / ledger mismatches) | `services/reconcile.py` | `test_reconciliation_finds_drift_and_unrecorded_charges` |
| Saga: reserve inventory -> charge -> ship, compensations persisted | `services/saga.py` | `test_saga_success_and_compensation` |
| Money in integer minor units, half-up fee rounding | `services/money.py` | `test_fee_rounding_half_up_in_minor_units` |
| Payment dashboard | `payments/dashboard.html` | manual |

25 tests, stable across repeated runs.

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head
PROVIDER_WEBHOOK_URL=http://127.0.0.1:8009/webhooks/provider ../../.venv/Scripts/uvicorn mockprovider.app:app_from_env --factory --port 8019
../../.venv/Scripts/uvicorn payments.main:app --port 8009
../../.venv/Scripts/python demo.py http://127.0.0.1:8009
../../.venv/Scripts/python -m pytest -q
```

Docker: `docker compose up -d --build` (API 127.0.0.1:58009, mock provider, recovery worker), then
`python demo.py http://127.0.0.1:58009`.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- One mock provider; no 3-D Secure / redirects, disputes/chargebacks only simulated via reconciliation drift.
- Single capture per authorization; no multi-currency conversion; no payouts/settlement to merchants.
- Saga is not resumed automatically after a process crash mid-saga (steps are persisted; resume is documented).
- Merchant auth is a single API key per merchant; no PCI scope (tokens only, no card data).
- Reconciliation days are UTC days.
