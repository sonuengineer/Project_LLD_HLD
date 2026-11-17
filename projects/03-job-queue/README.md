# Project 3 -- Distributed Job Queue

A reliable background job system: Redis for queue mechanics (every state change is one atomic Lua
script), worker processes with leases and fencing tokens, retries with jittered exponential backoff,
a dead letter queue, recurring schedules, and Postgres-backed idempotent handlers that turn
at-least-once delivery into effectively-once side effects.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Producer API (enqueue, get, list, cancel) with bearer auth | `jobqueue/api/routes.py` | `tests/test_api.py` |
| Multiple worker processes, N concurrent slots each | `jobqueue/worker/worker.py` | `test_worker.py`, `test_crash_process.py` |
| Priorities 0-9 + FIFO within priority; strict priority across queues | `core/lua/enqueue.lua`, `claim.lua` | `test_priority_then_fifo`, `test_queue_priority_across_queues` |
| Delayed (`delay_seconds`) and scheduled (`run_at_ms`) jobs | `enqueue.lua`, `claim.lua` (promotion) | `test_delayed_and_scheduled_jobs` |
| Recurring schedules, single-fire across N schedulers, missed runs skipped | `schedule_tick.lua`, `JobQueue.tick_schedules` | `test_schedule_fires_once_even_with_many_schedulers` |
| Retry with exponential backoff + full jitter | `core/backoff.py`, `fail.lua` | `test_retry_with_backoff_then_dead_letter`, `test_backoff_is_bounded_and_jittered` |
| Dead letter queue, replay one / all, permanent errors skip retries | `fail.lua`, `requeue_dead.lua` | `test_dlq_requeue_flow`, `test_permanent_error_skips_remaining_attempts` |
| Job timeout (local) | `Worker._execute` (`asyncio.wait_for`) | `test_end_to_end_success_retry_poison_timeout` |
| Leases (visibility timeout), lease extension, reaper | `claim.lua`, `extend_lease.lua`, `JobQueue.reap_expired` | `test_visibility_timeout_reaper_and_fencing`, `test_extended_lease_is_not_reaped` |
| Fencing tokens: zombie workers can't ack/fail/extend | `ack.lua`, `fail.lua` | same |
| Exactly-once claiming under 20 concurrent claimers | `claim.lua` | `test_concurrent_claimers_get_each_job_exactly_once` |
| Idempotent enqueue (idempotency key) | `enqueue.lua` | `test_enqueue_idempotency_key`, API 201 vs 200 |
| Idempotent processing (processed_jobs ledger in the same tx) | `handlers/builtin.py::send_email` | `test_redelivery_after_crash_is_idempotent`, `test_kill_minus_nine_worker_process` |
| Worker heartbeats, health, graceful shutdown (drain) | `Worker._heartbeat_loop`, `_shutdown` | `test_heartbeat_and_graceful_shutdown`, `test_workers_endpoint_reports_stale` |
| Dashboard (queues, workers, DLQ with requeue button) | `jobqueue/dashboard.html`, `/dashboard` | manual |
| Batch claiming (1 round trip for N jobs) | `claim.lua`, `JobQueue.claim_many` | `test_claim_many_returns_best_jobs_in_one_call` |

30 tests passing. Throughput numbers in [TESTING.md](TESTING.md).

## Run locally

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head
../../.venv/Scripts/uvicorn jobqueue.main:app --port 8003            # terminal 1
../../.venv/Scripts/python -m jobqueue.worker --queues critical,default,low --concurrency 8   # terminal 2 (run more for more workers)
../../.venv/Scripts/python seed.py http://127.0.0.1:8003
open http://127.0.0.1:8003/dashboard  (token: change-me-jq-token)
../../.venv/Scripts/python -m pytest -q
```

Docker: `docker compose up -d --build` (API on 127.0.0.1:58003, 3 workers, own Redis + Postgres).

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- Workers poll (adaptive 50ms -> 1s) instead of being pushed; idle latency up to 1s.
- Schedules are interval-based (every N seconds), not cron expressions.
- Redis is the queue's source of truth: running Redis without AOF/replication risks losing queued jobs.
- Lua scripts build job keys dynamically (not declared in KEYS) -> fine on one Redis, needs hash tags per queue for Redis Cluster.
- No per-tenant fairness or rate limiting inside the queue (see Project 6 / Project 1).
