# Testing -- flowengine

```bash
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p10_workflows_test upgrade head
../../.venv/Scripts/python -m pytest -q        # 30 tests, ~21s, stable over 3 consecutive runs after the review fixes
../../.venv/Scripts/python bench/bench.py
```

| File | Count | Covers |
|---|---|---|
| `test_runtime.py` | 10 | pure replay on hand-built histories: first command, continue + complete, ActivityError into code, non-determinism, signal-vs-timer race both orders, signal buffering, parallel activities (gather), cancellation + compensation, deterministic helpers |
| `test_engine.py` | 14 | real workers + Postgres: all 5 example workflows, retries with backoff, non-retryable + compensation, saga, signal vs timer, durable timer, escalation + cancellation, parallel batches, idempotent start, worker crash -> resume, heartbeat timeout, 2 workers x 20 workflows without duplicates, bad deploy detected + rollback resumes, stale workflow task discarded |

Every example activity records its effect under its idempotency key, so the tests assert exact effect counts
(e.g. `{"reserve": 20, "charge": 20, "ship": 20, "email": 20}` for 20 workflows on 2 workers).

## Benchmarks (real run, 2026-11-17; Postgres in Docker Desktop on Windows)

| Setup | Workflows/s (4 activities each, 60 workflows) |
|---|---|
| 1 worker, in-process | 5.2 |
| 2 workers, same process | 5.2 -- 6.1 (CPU-bound: 80% of wall; 97 SQL statements per workflow) |
| 1 worker process | 4.9 |
| 2 worker processes | 7.6 |
| 4 worker processes | 8.3 (includes process start-up; shared Postgres) |

| Replay of N history events | Time |
|---|---|
| 21 | 0.5 -- 2.1 ms |
| 201 | 3.4 -- 12.6 ms |
| 2,001 | 102 -- 132 ms |

Replay cost grows super-linearly with history length -- the practical reason for continue-as-new and sticky
caches in production engines.

## Review fixes (2026-11-17)

`tests/test_review_fixes.py` (6 tests), from a code review done while writing the interview bank:

| Test | Bug / gap it pins |
|---|---|
| `test_timer_where_history_has_activity_is_nondeterminism_not_keyerror` | replay raised KeyError (not NonDeterminismError) when new code produced a timer where history had an activity; the worker only logged it and re-claimed the workflow forever with no error shown |
| `test_start_to_close_timeout_retries_then_fails` | start-to-close timeout had no test |
| `test_cancel_stops_running_activity_and_it_is_never_retried` | cancel only cancelled *scheduled* activities: a running one completed after close (event appended to a closed history) or was reaped and retried |
| `test_late_activity_completion_after_close_appends_nothing` | `complete_activity` / `fail_activity` appended history after the workflow closed |
| `test_stale_commit_does_not_clear_another_workers_lease` | a stale commit cleared the lease even when another worker owned it by then |
| `test_retry_task_requeues_only_running_workflows` | no way to resume a workflow blocked by a replay error except a manual SQL UPDATE (new `POST /workflows/{id}/retry-task`, admin token) |

Also: activity retry delays now have +-20% jitter (no lockstep retries after a shared outage).

