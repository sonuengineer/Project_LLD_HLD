# API -- Webhook Delivery

Auth: `Authorization: Bearer <WH_API_TOKEN>`. OpenAPI at `/docs`.

| Method | Path | Notes |
|---|---|---|
| POST | `/endpoints` | `{url, description?, event_types?, rate_limit_per_second?}` -> 201 incl. `secret` |
| GET | `/endpoints`, `/endpoints/{id}` | secret never included |
| PATCH | `/endpoints/{id}` | url, event_types, rate, `enabled` (re-enable resets failure count) |
| GET | `/endpoints/{id}/secret` | current secret |
| POST | `/endpoints/{id}/rotate-secret` | `{grace_seconds}` -> new secret; old one keeps signing until expiry |
| POST | `/endpoints/{id}/replay-dead` | requeue all dead deliveries of an endpoint |
| POST | `/events` | `{type, payload, idempotency_key?}` -> 201 `{event, deliveries}`; 200 on idempotent replay |
| GET | `/events/{id}` | event + its deliveries |
| GET | `/deliveries?status=&endpoint_id=` | recent deliveries |
| GET | `/deliveries/{id}` | delivery + attempt log (code, outcome, duration, response snippet) |
| POST | `/deliveries/{id}/retry` | replay a dead or succeeded delivery; 409 if pending/in flight |
| GET | `/stats` | counts by status, endpoints enabled/disabled, oldest pending |

## What a customer receives

```
POST /webhook
content-type: application/json
webhook-id: evt_3f1c...                      (stable across retries)
webhook-timestamp: 1763301234
webhook-signature: v1,K5o... v1,9Qa...       (two during rotation)

{"id":"evt_3f1c...","type":"order.paid","created_at":"2026-11-16T17:30:00+00:00","data":{...}}
```

Verify (Python, using this repo's helper):

```python
from webhooks.services.signing import verify, VerificationError
verify([MY_SECRET], dict(request.headers), raw_body)   # raises VerificationError
```

Respond 2xx within 10s; anything else is retried. Return `410` to unsubscribe permanently.
