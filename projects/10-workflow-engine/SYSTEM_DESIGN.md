# System Design -- flowengine

## Workflow vs job queue

| | Job queue (Project 3) | Workflow engine (this) |
|---|---|---|
| Unit | one independent task | a long-running process of many steps |
| State between steps | your problem (DB flags, chains of jobs) | the engine's: history + replay |
| Waiting days for a signal / timer | awkward (polling, cron) | `await ctx.wait_signal(...)`, `await ctx.sleep(days)` |
| Failure in step 3 of 5 | manual cleanup | try/except around activities, compensations in code |
| Visibility | per job | full per-process history timeline |

## Durable execution via event sourcing

State is never stored; it is re-derived by replaying deterministic code against an append-only log of facts
("activity 2 completed with X", "signal approve received"). Any worker can rebuild any workflow at any time,
so crashes lose no progress and workers need no affinity.

Determinism rules for workflow code: no wall clock (use `ctx.now()`), no randomness (`ctx.random()`,
`ctx.uuid4()`), no I/O (use activities), no threads; same inputs + same history -> same commands.

## Long-running transactions (sagas)

`order_processing` is a saga written as plain code: each step is an activity; failures raise into the workflow,
which runs compensations (refund, release). Because the workflow itself is durable, compensations are
guaranteed to run even if workers crash mid-way -- the weak spot of hand-written sagas.

## Performance characteristics (measured, TESTING.md)

- ~97 SQL statements per 4-activity workflow; one process is CPU-bound (~5 workflows/s); separate worker
  processes scale (4.9 -> 7.6 -> 8.3 workflows/s for 1/2/4 processes on this machine).
- Replay cost grows with history: 0.5 ms (21 events), 3.4 ms (201), 102 ms (2,001).

## Scaling path

| Scale | Change |
|---|---|
| 10x | more worker processes; per-type task queues; sticky caching of workflow state on the worker that last ran it (skip full replay) |
| 100x | shard workflows by workflow_id across databases (Temporal "history shards"); separate matching service for task queues; push-based task delivery instead of polling |
| Long histories | continue-as-new (start a fresh run carrying state), history size limits |
