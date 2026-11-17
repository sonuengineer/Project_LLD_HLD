# Testing -- Webhook Delivery

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p04_webhooks_test upgrade head
../../.venv/Scripts/python -m pytest -q          # 41 tests, ~11s
```

The dispatcher's HTTP client is wired to the **real receiver app** via `httpx.ASGITransport`, so
signing and verification run end to end without sockets. Failure modes use `httpx.MockTransport`.

| File | Count | Covers |
|---|---|---|
| `test_signing_ssrf.py` | 16 | Standard Webhooks reference vector, tamper detection (body/id/secret), replay tolerance both directions, dual-signature rotation, missing headers, 9 blocked SSRF destinations, public IP allowed, URL syntax rules |
| `test_dispatcher.py` | 14 | real signed delivery, wrong secret -> dead after 4 attempts, transient failures, backoff jitter window, 410, 429 Retry-After, timeout, SSRF at send time, auto-disable, per-endpoint rate limit refunds attempts, 3 dispatchers x 150 events each exactly once, crash + lease expiry + stale zombie write, secret rotation end to end, receiver dedupe on replay |
| `test_publish_api.py` | 5 | fan-out by subscription, idempotency key, atomic publish (rollback), API flow, URL rejection in production mode |

## Fixes from the interview-bank code review (with regression tests)

| Finding | Fix | Test |
|---|---|---|
| Dispatcher process exited on a DB error in `claim()` (docs claimed it retried) | `run()` catches, logs, backs off up to 30s | `test_dispatch_loop_survives_database_errors` |
| A delivery whose processing always raised stayed in_flight forever, attempts unbounded | crash recorded as an `internal_error` attempt; claim-time backstop dead-letters expired rows after the final attempt | `test_crashing_delivery_eventually_goes_dead`, `test_claim_backstop_dead_letters_exhausted_expired_rows` |
| SSRF check-then-connect: DNS resolved twice (rebinding window) | connect to the validated IP; Host header + TLS SNI keep the hostname | `test_connection_is_pinned_to_the_validated_ip` |
| Unbounded `Retry-After` | capped at 24h | `test_retry_after_is_capped` |
| Uppercase event types accepted but never matched | validation uses the publish-side pattern | `test_uppercase_event_type_subscription_rejected` |
| Response body read fully before trimming | streamed, stops at 1KB | covered by all delivery tests |
| `secret_rotation_in_progress` stayed true after expiry; no Redis socket timeouts | computed from expiry; 0.5s timeouts | -- |

(One more bug surfaced while fixing: `aiter_raw()` raises `StreamConsumed` on already-read bodies, which
mock responses are; `aiter_bytes()` handles both.)

## Throughput investigation (real runs, 2026-11-16)

Method that is honest: `bench/bench_drain.py` builds a backlog with dispatchers **stopped**, then
starts N dispatcher containers and times the drain. (A first attempt measured while publishing was
still running and printed a meaningless 7,526/s; discarded. A second attempt hung because an older
endpoint from the seed was still subscribed and failing -- now every run starts from `down -v`.)

| Version | 1 dispatcher | 3 dispatchers |
|---|---|---|
| v1: separate reads per delivery, 5-statement record transaction | 48 deliveries/s | not measured |
| v2: claim returns all data (CTE join), record = 1 statement, no endpoint write on routine success | **111 deliveries/s** | **189 deliveries/s** |

3000 deliveries per run, receiver verified every signature, 0 duplicates. Includes container start-up.

How the bottleneck was found (`bench/phase_timing.py`, local, 300 deliveries):

- Concurrency 20, v1: `deliver` avg 318ms of which `_record` 116ms, HTTP send only 1.7ms.
- Concurrency 1, v1: `_record` 17ms, `deliver` 32ms -> per delivery ~40ms of pure DB round trips.
- Hypothesis "hot endpoint row lock" was only partly right (spreading over 20 endpoints: 50 -> 52/s).
- Hypothesis "WAL fsync" was tested with `synchronous_commit=off`: no change -> rejected.
- After v2, process CPU = 82% of wall time -> the single process is CPU-bound in Python; the remaining
  lever is more dispatcher processes (hence 3 dispatchers scale further).

Environment: Windows 11 + Docker Desktop, 12 vCPU shared with ~25 other containers.
