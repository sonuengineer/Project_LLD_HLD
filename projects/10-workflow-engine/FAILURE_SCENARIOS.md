# Failure Scenarios -- flowengine

| # | Scenario | Behaviour | Test |
|---|---|---|---|
| 1 | Worker crashes between workflow steps | nothing in memory is needed: another worker replays history and continues | `test_worker_crash_another_worker_resumes_from_history` |
| 2 | Worker crashes mid-activity | heartbeat lease expires (0.5s here), attempt counted as timeout, retried elsewhere; effect once | `test_activity_heartbeat_timeout_detects_dead_worker` |
| 3 | Transient activity failure | retried with exponential backoff (`visible_at`) | `test_retries_with_backoff_then_success_effect_once` |
| 4 | Permanent failure (non-retryable / attempts exhausted) | ActivityFailed raised in workflow code -> compensation | `test_non_retryable_failure_runs_compensation`, `test_saga_compensation_when_shipping_fails` |
| 5 | Activity hangs | start-to-close timeout -> retry/fail | `test_start_to_close_timeout_retries_then_fails` |
| 6 | Signal arrives while a workflow task is replaying | commit rejected (history moved), task re-runs with the signal | `test_stale_workflow_task_is_discarded_when_history_moves` |
| 7 | Signal arrives before the code waits for it | buffered in history, delivered when awaited | `test_customer_onboarding_with_signal_and_durable_timer` |
| 8 | Signal and timeout race | resolved by recorded event order, identically on every replay | `test_race_signal_first_wins`, `test_race_timer_first_wins` |
| 9 | Cancellation | delivered as WorkflowCancelled into pending awaits; compensations run; scheduled AND running activity tasks cancelled (a running one sees `heartbeat() == False` and its completion is fenced); nothing is appended to a closed history | `test_document_approval_escalation_and_cancellation`, `test_cancel_stops_running_activity_and_it_is_never_retried`, `test_late_activity_completion_after_close_appends_nothing` |
| 10 | Bad deploy changes step order (or a timer where an activity was) | NonDeterminismError recorded, workflow stays running/blocked; fix the code, check with replay-check, then `POST /workflows/{id}/retry-task` | `test_nondeterministic_deploy_is_detected_and_workflow_survives`, `test_timer_where_history_has_activity_is_nondeterminism_not_keyerror` |
| 10b | Worker stalls past its workflow-task lease, another worker claims it | the stale worker's commit is rejected and it does NOT clear the new owner's lease | `test_stale_commit_does_not_clear_another_workers_lease` |
| 11 | Same workflow started twice | idempotent on workflow_id | `test_start_is_idempotent_on_workflow_id` |
| 12 | Many workers | SKIP LOCKED + unique (workflow_id, seq): no duplicate work | `test_two_workers_process_many_workflows_without_duplicates` |
| 13 | Graceful shutdown | finishes the current workflow task and in-flight activities (bounded) | worker tests |

## Bugs found by tests (fixed)

1. After cancellation, NEW futures were failed too, so compensation activities could never run.
2. `Worker.stop()` left in-flight activity tasks running in the background (orphaned) after "stopping".
3. Graceful stop cancelled a claimed workflow task mid-way, leaving its 10s lease held: other workers waited a
   full lease. Now the workflow loop finishes its task, and cancelled tasks release their lease.
4. Heartbeats extended the lease by start_to_close (30s) instead of the heartbeat timeout, defeating fast
   dead-worker detection.
5. (Test design) inserting a step with the SAME activity type isn't detected by type-level determinism checks.

## Known limitations (not fixed)

- The determinism check compares command kinds and activity types only, not activity arguments or timer durations.
- When a signal wins the race in `wait_signal(timeout=...)` the timer is not cancelled; it fires later and causes
  one extra (harmless) workflow task.
- `wait_signal` returns `None` both on timeout and for a signal whose payload is null.
- Timer `fire_at` uses the worker's clock while leases use the database clock (skew shifts timers).
- Heartbeat details are stored but not passed to the next attempt (a retried `long_task` restarts from chunk 0).
- Rows of crashed workers stay in `workers`; history endpoint has no pagination; worker `stats` are not exported
  as Prometheus metrics (DEPLOYMENT.md's timer-lag alert has no metric behind it yet).

