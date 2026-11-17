# Project 10 -- flowengine: a Durable Workflow Engine (Temporal-style)

Write a business process as ordinary async Python; the engine makes it **durable**: every step is recorded in
an append-only event history in Postgres, workers are stateless, and any worker can resume any workflow by
**replaying** its code against the history. Activities get retries with backoff, timeouts and heartbeats;
workflows get durable timers, signals and cancellation with compensation.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Workflow definitions (`@workflow`), activities (`@activity`) | `runtime.py`, `activities.py` | all |
| Durable execution history (event sourcing) | `store.py`, `history_events` | `test_order_processing_happy_path` |
| Deterministic replay in recorded event order; ctx.now/random/uuid | `runtime.py::replay` | `tests/test_runtime.py` (10) |
| Non-determinism detection; workflow kept running (not failed) until fixed; replay-check endpoint | `replay`, `complete_workflow_task`, `/replay-check` | `test_non_determinism_detected_when_code_changes`, `test_nondeterministic_deploy_is_detected_and_workflow_survives` |
| Task scheduling / task queues (SKIP LOCKED + leases) | `claim_workflow_task`, `claim_activity` | `test_two_workers_process_many_workflows_without_duplicates` |
| Retry policies (backoff, max attempts, non-retryable) | `RetryPolicy`, `fail_activity` | `test_retries_with_backoff_then_success_effect_once`, `test_non_retryable_failure_runs_compensation` |
| Timeouts (start-to-close) and heartbeats (fast dead-worker detection) | `Worker._execute`, `store.heartbeat` | `test_activity_heartbeat_timeout_detects_dead_worker` |
| Durable timers | `ctx.sleep`, `timers`, `fire_due_timers` | onboarding / campaign tests |
| Signals (buffered; race with timers resolved by history order) | `ctx.wait_signal`, `store.signal` | `test_payment_and_refund_signal_vs_timer`, `test_race_*` |
| Cancellation delivered into the workflow (compensation possible) | `store.cancel`, `WorkflowCancelled` | `test_document_approval_escalation_and_cancellation` |
| Failure recovery: worker crash -> another worker continues from history | stateless workers + leases | `test_worker_crash_another_worker_resumes_from_history` |
| Idempotent activities (stable idempotency key per activity) | `ActivityContext.idempotency_key` | effect counts in every test |
| Idempotent start (business workflow id) | `start_workflow` | `test_start_is_idempotent_on_workflow_id` |
| Optimistic workflow-task commit (history moved during replay) | `complete_workflow_task` | `test_stale_workflow_task_is_discarded_when_history_moves` |
| Worker registration + heartbeats | `workers` table | `/workers` |
| Execution dashboard | `flowengine/dashboard.html` | manual |
| Example workflows: order processing, payment & refund, onboarding, document approval, email campaign | `examples/workflows.py` | one test each |

30 tests, stable across repeated runs.

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head
../../.venv/Scripts/uvicorn flowengine.main:app --port 8010      # API + dashboard
../../.venv/Scripts/python -m flowengine                          # worker (run several)
../../.venv/Scripts/python demo.py http://127.0.0.1:8010
../../.venv/Scripts/python -m pytest -q
```

Docker: `docker compose up -d --build` (API 127.0.0.1:58010, 2 workers), then `python demo.py http://127.0.0.1:58010`.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- Full replay on every workflow task (no sticky in-memory cache): cost grows with history (measured); no continue-as-new.
- No workflow versioning API (`patched()`); no child workflows, queries, or schedules (cron).
- Non-determinism detection compares command/activity TYPES, not arguments (same as Temporal).
- Single Postgres is the bottleneck at scale (Temporal shards history across a cluster).
- API has no authentication (internal service in this demo).
