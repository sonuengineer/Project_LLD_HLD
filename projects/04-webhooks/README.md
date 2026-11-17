# Project 4 -- Webhook Delivery System

Stripe-style webhook infrastructure: endpoints subscribe to event types, events are published with an
idempotency key, and dispatchers deliver signed HTTP requests with retries, per-endpoint rate limits,
SSRF protection, auto-disable, a dead letter queue with replay, and zero-downtime secret rotation.
Postgres is both the outbox and the work queue (`FOR UPDATE SKIP LOCKED`).

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Endpoint registration, event-type subscriptions (`*` wildcard) | `services/endpoints.py`, `services/events.py` | `test_fanout_only_to_subscribers` |
| Event publishing, idempotency key, atomic fan-out (transactional outbox) | `services/events.py::publish` | `test_publish_idempotency_key`, `test_publish_is_atomic` |
| HMAC-SHA256 signatures (Standard Webhooks format, reference vector passes) | `services/signing.py` | `test_standard_webhooks_reference_vector` |
| Receiver verification: constant-time compare, timestamp tolerance (replay protection) | `signing.verify`, `receiver/app.py` | `test_replay_outside_tolerance_rejected` |
| Async delivery by N dispatchers with SKIP LOCKED + leases | `dispatcher/dispatcher.py` (`CLAIM_SQL`) | `test_three_dispatchers_deliver_each_exactly_once` |
| Retry with backoff + jitter; `Retry-After` honoured | `Dispatcher._next_delay` | `test_retry_schedule_with_backoff`, `test_429_retry_after_is_honoured` |
| Delivery logs (every attempt) + status tracking | `delivery_attempts` table, `GET /deliveries/{id}` | `test_transient_failures_then_success` |
| Dead letter + replay (single, per endpoint) | `POST /deliveries/{id}/retry`, `/endpoints/{id}/replay-dead` | `test_api_flow`, `test_receiver_dedupes_replayed_delivery` |
| Idempotent receiver (dedupe on `webhook-id`) | `receiver/app.py` | same |
| Endpoint timeouts (connect 3s / total 10s), timeout/connect errors logged | `Dispatcher._send` | `test_timeout_and_connect_errors_are_logged` |
| Per-endpoint rate limiting (Redis token bucket), not counted as an attempt | `services/ratelimit.py` | `test_per_endpoint_rate_limit_does_not_burn_attempts` |
| 410 Gone disables endpoint; auto-disable after N consecutive failures | `RECORD_SQL` | `test_410_gone_disables_endpoint`, `test_auto_disable_after_consecutive_failures` |
| SSRF protection at send time (DNS resolved, private ranges blocked, no redirects) | `services/ssrf.py` | `test_ssrf_blocks_internal_destinations`, `test_ssrf_destination_blocked_at_send_time` |
| Secret rotation with dual signatures during a grace window | `EndpointService.rotate_secret`, `_active_secrets` | `test_secret_rotation_without_failed_deliveries` |
| Crash recovery (lease expiry) + fencing against zombie dispatchers | `CLAIM_SQL`, `RECORD_SQL` | `test_crashed_dispatcher_lease_expires_and_zombie_result_is_rejected` |
| Delivery dashboard | `webhooks/dashboard.html` | manual |

41 tests passing. Throughput investigation in [TESTING.md](TESTING.md).

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head
WH_ALLOW_PRIVATE_DESTINATIONS=true ../../.venv/Scripts/uvicorn webhooks.main:app --port 8004
WH_ALLOW_PRIVATE_DESTINATIONS=true ../../.venv/Scripts/python -m webhooks.dispatcher
../../.venv/Scripts/uvicorn webhooks.receiver.app:app --port 9000
../../.venv/Scripts/python -m pytest -q
```

Docker (API 127.0.0.1:58004, 2 dispatchers, demo receiver 127.0.0.1:58014):
`docker compose up -d --build && python seed.py http://127.0.0.1:58004 http://127.0.0.1:58014`.
Note the seed uses `http://receiver:9000` -- the compose file sets `WH_ALLOW_PRIVATE_DESTINATIONS=true`
for that demo only.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- No ordering guarantee between events (retries reorder); consumers must use `created_at` / fetch latest state.
- Single admin token; no per-customer accounts (multi-tenancy is Project 6).
- `Retry-After` HTTP-date format not parsed (seconds only).
- The secret is stored in plaintext in Postgres (it must be, to sign); production should encrypt it with a KMS key.
- Old `events` / `delivery_attempts` rows are never pruned (needs a retention job / partitioning).
