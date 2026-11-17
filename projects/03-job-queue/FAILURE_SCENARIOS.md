# Failure Scenarios -- Distributed Job Queue

| # | Scenario | Behaviour | Verified by |
|---|---|---|---|
| 1 | Worker process hard-killed mid-job (after commit, before ack) | Lease expires, any worker's reaper re-queues (backoff), next attempt sees `processed_jobs` row -> no duplicate effect | `test_kill_minus_nine_worker_process` (real subprocess + kill) |
| 2 | Worker stalls past its lease, then wakes up (zombie) | Its ack/fail/extend are rejected (fencing token); new owner's result stands | `test_visibility_timeout_reaper_and_fencing` |
| 3 | Handler raises (transient) | Retry after jittered exponential backoff | `test_retry_with_backoff_then_dead_letter`, flaky handler |
| 4 | Poison message (always fails) | Exhausts `max_attempts` -> DLQ, never loops forever | `demo.poison` in `test_end_to_end_...` |
| 5 | Non-retryable error (bad payload, unknown type) | `PermanentError` -> DLQ immediately | `test_permanent_error_skips_remaining_attempts`, unknown type |
| 6 | Handler hangs | `asyncio.wait_for` timeout -> fail(reason=timeout) -> retry/DLQ | `demo.sleep` with 0.2s timeout |
| 7 | Handler blocks the event loop (CPU / `time.sleep`) | Lease extensions stop -> job may be redelivered while still running -> idempotency required | `demo.cpu_block` handler (documented anti-pattern) |
| 8 | Many workers reap the same expired job | `fail.lua` re-checks status + deadline: exactly one wins | Lua logic; concurrency of claim proven by `test_concurrent_claimers_...` |
| 9 | Worker shutdown (deploy) | SIGTERM -> stop claiming, drain in-flight up to grace; leftovers are cancelled and recovered by lease expiry | `test_heartbeat_and_graceful_shutdown` |
| 10 | Duplicate enqueue (client retry after timeout) | Same idempotency key -> same job, HTTP 200 | `test_idempotent_enqueue_returns_200_and_same_job` |
| 11 | Several schedulers fire the same schedule | Compare-and-advance + per-slot idempotency key -> one job | `test_schedule_fires_once_even_with_many_schedulers` |
| 12 | Long downtime with schedules | One run, then realigned (no burst) | same test |
| 13 | Worker heartbeat stops | `/workers` shows `alive: false` after 3 intervals; its jobs are recovered by leases, not by heartbeats | `test_workers_endpoint_reports_stale` |
| 14 | Redis unavailable | Enqueue fails (API 500 -> producer must retry with an idempotency key); workers log `claim_failed` and back off | code paths in `Worker._claim_next` |
| 15 | Redis loses data (no persistence) | Queued jobs lost -- run Redis with AOF `everysec` + replica (compose does AOF) | DEPLOYMENT.md |

## The duplicate-execution window, precisely

At-least-once means a handler can run twice when: (a) the worker dies after the side effect but
before ack, (b) the lease expires while the handler is still running (blocked loop, GC pause, network
partition to Redis), or (c) ack fails on the network after Redis applied it... (then retry of ack is
harmless: token check). The `processed_jobs` ledger in the same transaction as the effect makes
(a) and (b) safe for database effects. For external effects (real email APIs), pass the job id as the
provider's idempotency key.
