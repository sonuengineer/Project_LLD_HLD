# Database Design -- flowengine

```mermaid
erDiagram
  WORKFLOWS ||--|{ HISTORY_EVENTS : "append-only log"
  WORKFLOWS ||--o{ ACTIVITY_TASKS : schedules
  WORKFLOWS ||--o{ TIMERS : sets
  WORKFLOWS { text workflow_id PK uuid run_id text workflow_type text status bool needs_task bigint last_event_id timestamptz lease_until }
  HISTORY_EVENTS { text workflow_id PK bigint event_id PK text event_type jsonb attrs }
  ACTIVITY_TASKS { bigint id PK text workflow_id int seq text activity_type text status int attempt jsonb retry timestamptz visible_at timestamptz lease_until }
  TIMERS { text workflow_id PK int seq PK timestamptz fire_at bool fired }
  WORKERS { text worker_id PK text_array task_queues timestamptz last_heartbeat }
```

| Design point | Why |
|---|---|
| `history_events (workflow_id, event_id)` PK, gap-free ids assigned under the workflow row lock | total order of facts per workflow; replay is deterministic |
| `workflows.last_event_id` | optimistic check: a workflow-task result is only committed if no event arrived during replay |
| `needs_task` + partial index on running workflows | pollers scan only workflows with work |
| `activity_tasks UNIQUE (workflow_id, seq)` | a command can never be scheduled twice |
| `visible_at` | retry backoff without a scheduler: tasks become claimable later |
| `lease_until` + `attempt` | crash recovery (reaper) and fencing (stale completions rejected) |
| `timers` with partial index on unfired | durable timers survive restarts |
| `activity_effects` (examples) | proves exactly-once side effects via the idempotency key |

Event types: WorkflowStarted, ActivityScheduled, ActivityCompleted, ActivityFailed, TimerStarted, TimerFired,
SignalReceived, CancelRequested, WorkflowCompleted, WorkflowFailed, WorkflowCancelled.
