# API -- Payment System (mock provider, test money)

Auth: `Authorization: Bearer sk_test_...` (merchant). Admin: `x-admin-token`. OpenAPI: `/docs`.
All mutating payment endpoints REQUIRE `Idempotency-Key`. Replays carry `Idempotent-Replayed: true`.

| Method | Path | Notes |
|---|---|---|
| POST | `/payments` | `{amount (minor units), currency, payment_method: tok_*, merchant_reference, capture?, description?}` -> 201 payment |
| POST | `/payments/{id}/capture` | `{amount?}` partial or full |
| POST | `/payments/{id}/void` | release an uncaptured authorization |
| POST | `/payments/{id}/refunds` | `{amount, reason?}` -> refund (succeeded / failed / requires_reconciliation) |
| GET | `/payments/{id}` | payment + event timeline + refunds |
| GET | `/payments?status=` | list |
| GET | `/ledger/balances` | derived from entries |
| POST | `/checkout` | saga demo: `{order_id, items:[{sku, qty}], amount, payment_method, simulate_shipping_failure?}` |
| POST | `/webhooks/provider` | provider -> us, `x-provider-signature: t=..,v1=..` |
| POST | `/admin/merchants` | -> `{merchant_id, api_key}` (shown once) |
| POST | `/admin/recovery/run?stuck_after_seconds=` | resolve stuck / ambiguous |
| POST | `/admin/reconciliation/runs?day=YYYY-MM-DD` | UTC day |
| GET | `/admin/reconciliation/runs/{id}` | exceptions |
| GET | `/admin/ledger/trial-balance` | must be 0 |
| POST | `/admin/inventory?sku=&available=` | saga demo stock |

## Test tokens (mock provider)

`tok_visa` ok . `tok_declined` . `tok_insufficient_funds` . `tok_slow` (provider succeeds, client times out) .
`tok_flaky` (500 then ok) . `tok_capture_fails` (capture 402).

## Errors

`duplicate_payment` 409, `invalid_state_transition` 409, `idempotency_key_reused` 422,
`conflict` (idempotency in progress) 409, `unprocessable` 422 (over-refund, bad amount), `not_found` 404.
