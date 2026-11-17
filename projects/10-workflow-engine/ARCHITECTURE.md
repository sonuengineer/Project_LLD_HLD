# Architecture -- flowengine

```
flowengine/
  runtime.py      WorkflowContext (activities, timers, signals, deterministic helpers), replay(), RetryPolicy
  store.py        history appends, workflow/activity task claiming, completion, timers, reaper, workers
  worker.py       pollers: workflow tasks (replay), activities (execute), timers + reaper, heartbeat
  activities.py   @activity registry, ActivityContext (idempotency key, heartbeat)
  api.py          start / signal / cancel / describe / history / replay-check / workers / stats
  examples/       five workflows + their activities
```

## Components

```mermaid
flowchart LR
  C[Client / API] -->|start, signal, cancel| PG[(Postgres<br/>workflows, history_events,<br/>activity_tasks, timers, workers)]
  subgraph Workers [stateless worker processes]
    WT[workflow-task poller<br/>replay code vs history]
    AT[activity poller<br/>execute side effects]
    TM[timer + reaper loop]
  end
  PG <-->|claim SKIP LOCKED / commit| WT
  PG <-->|claim / complete / fail / heartbeat| AT
  PG <-->|fire timers / expire leases| TM
```

## One step of a workflow

```mermaid
sequenceDiagram
  participant API
  participant DB as Postgres
  participant WW as Worker (workflow task)
  participant AW as Worker (activity)
  API->>DB: WorkflowStarted (needs_task = true)
  WW->>DB: claim workflow (lease), read history 1..N
  WW->>WW: replay code; it asks for activity "charge" (seq 2)
  WW->>DB: tx: last_event_id still N? append ActivityScheduled(seq 2), insert activity task
  AW->>DB: claim activity (SKIP LOCKED, lease)
  AW->>AW: run charge_payment (idempotency key wf:2)
  AW->>DB: tx: ActivityCompleted(seq 2, result), needs_task = true
  WW->>DB: claim again, replay 1..N+2: seq 2 now resolved -> code continues
```

## Replay in event order

```mermaid
flowchart TD
  S[start coroutine, settle] --> E{next history event}
  E -- ActivityScheduled / TimerStarted --> M{code produced same command type at this seq?}
  M -- no --> ND[NonDeterminismError: workflow stays running, error recorded]
  M -- yes --> E
  E -- Completed / Failed / TimerFired / Signal / CancelRequested --> R[resolve future, settle] --> E
  E -- end of history --> O{coroutine finished?}
  O -- yes --> CL[append WorkflowCompleted / Failed / Cancelled]
  O -- no --> NEW[append new commands; wait for more events]
```
