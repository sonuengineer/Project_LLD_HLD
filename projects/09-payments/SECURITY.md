# Security -- Payment System

| Area | Measure |
|---|---|
| Real money / PAN data | none: mock provider only; payment methods are opaque tokens (`tok_*`), never card numbers (keeps out of PCI DSS scope) |
| Merchant authentication | `sk_test_` API keys, SHA-256 hashed at rest, shown once |
| Admin endpoints | separate admin token (constant-time compare) |
| Provider webhooks | HMAC-SHA256 over `timestamp.body`, 5-min tolerance, constant-time compare, event-id dedupe |
| Tampering with history | ledger entries and payment_events are append-only, both enforced by triggers (payment_events since migration 0002); the ledger also balances per currency |
| Double-spend / over-refund | DB constraints + row locks + pending-refund accounting |
| Replay of payment requests | idempotency keys bound to request hash |
| Amount manipulation | integer validation, CHECK constraints, capture <= authorized |
| Data exposure across merchants | every query filtered by merchant id; payment ids are UUIDs |

Gaps (documented): no rate limiting per merchant (see Project 1), no secret rotation for provider webhook secret,
admin token instead of RBAC (see Project 6), no encryption at rest.
