# Testing -- Distributed Job Queue

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p03_job_queue_test upgrade head
../../.venv/Scripts/python -m pytest -q        # 30 tests, ~15s
```

Redis DB 2 and Postgres DB `p03_job_queue_test` are wiped per test.

| File | Count | What it proves |
|---|---|---|
| `test_queue_core.py` | 14 | priority+FIFO, delayed/scheduled, idempotent enqueue, ack, retry->backoff->DLQ->requeue, permanent errors, lease expiry + reaper + **fencing** (zombie ack/fail/extend rejected), lease extension, cancel, **20 concurrent claimers x 1000 jobs = each exactly once**, schedules single-fire with 5 schedulers + no burst after downtime, backoff bounds/jitter, validation, batch claim |
| `test_worker.py` | 4 | real in-process workers: success, flaky retries, poison -> DLQ, timeout, unknown type; cross-queue priority; crash after commit -> redelivery is idempotent (1 email row); heartbeat + graceful drain |
| `test_crash_process.py` | 1 | **real worker OS process killed** after its handler committed; second process finishes the job with `attempts=2`, `duplicate=true`, exactly 1 email row |
| `test_api.py` | 7 | auth, enqueue/get/list/cancel, idempotent 201 vs 200, validation 422, DLQ requeue, schedules CRUD, stale worker detection |

## Bugs found by tests (fixed)

1. Heartbeat TTL computed as `int(interval * 3)` = 0 for sub-second intervals -> Redis rejected
   `SET ... EX 0` and the heartbeat loop crashed. Now `px=` in milliseconds.
2. Found during the interview-bank code review, fixed with regression tests:
   - `_keep_lease` had no error handling: one Redis error ended lease extension for the rest of the job
     -> silent lease expiry -> duplicate execution. Test: `test_lease_keeper_survives_transient_redis_errors`.
   - `claim.lua` parsed fields after `ZPOPMIN`; a corrupt field made the script error, and Redis does
     not roll back writes already made by a script -> the job vanished. Now defaults are used and
     unparseable records are dead-lettered. Test: `test_corrupt_job_field_does_not_lose_the_job`.
   - Schedule catch-up looped once per missed interval inside Redis (could block Redis after long
     downtime). Now O(1). Test: `test_schedule_catch_up_is_constant_time`.
   - Error lists and cancelled jobs never expired. Test: `test_finished_and_cancelled_jobs_expire`.
   - Dashboard rendered job ids without escaping (ids are server-generated hex, fixed anyway).
3. (Test bug) cross-queue priority was asserted by counting completions at a polling instant; the
   correct assertion compares `started_at`.

## Throughput (real runs, 2026-11-16)

`bench/throughput.py`: 5000 no-op jobs (`report.generate` with 0s), real worker subprocesses,
16 slots each, Redis 7 in Docker Desktop on Windows 11 (shared, ~25 other containers). Time includes
worker process start-up.

| Version | 1 worker process | 4 worker processes |
|---|---|---|
| Before: claim 1 job per call + separate HGETALL | 158 jobs/s | 440 jobs/s |
| After: batch claim up to free slots, job hash returned inline | **577 jobs/s** | **1,227 jobs/s** |

Diagnosis: the claim loop was serial (one claim + one HGETALL round trip per job), so free slots
sat idle waiting for claims. Fix: `claim.lua` takes `max_jobs` and returns hashes inline.
Enqueue rate from one Python producer: ~750-1,190 jobs/s (each enqueue = SADD + EVALSHA).

## Docker end-to-end (manual, verified)

`docker compose up -d --build` + `python seed.py http://127.0.0.1:58003`: after ~8s the critical
email succeeded, poison job dead after 3 attempts, flaky job succeeded after retries, delayed job
still delayed, schedule fired into `low`, 3 workers reported alive.
