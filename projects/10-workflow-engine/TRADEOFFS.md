# Trade-offs -- flowengine

1. **Replay vs storing workflow state.** Replay gives crash-proof, worker-agnostic execution and a full audit
   trail; it imposes determinism rules on workflow code and costs CPU that grows with history (measured).
2. **Full replay every task vs sticky cache.** Simple and always correct; Temporal caches workflow state on the
   last worker and only replays on a cache miss.
3. **Postgres for everything (history, queues, timers).** One durable, transactional store, easy to inspect;
   becomes the bottleneck (~97 statements per 4-activity workflow) and needs sharding at scale.
4. **Polling with SKIP LOCKED vs push.** Simple and robust; adds latency (poll interval) and idle queries.
5. **Optimistic workflow-task commit.** No long locks during replay; occasionally wasted replays when signals race.
6. **Non-determinism leaves the workflow running (blocked) rather than failing it.** A bad deploy can be rolled
   back and workflows resume; requires monitoring of the `error` field.
7. **Type-level determinism check.** Cheap and matches Temporal; argument changes go undetected.
8. **Heartbeat-based leases.** Fast dead-worker detection for long activities; needs activities to heartbeat.
9. **At-least-once activities + idempotency key.** No distributed transactions with external systems; activity
   authors must use the key for exactly-once effects.
10. **Graceful stop drains in-flight work.** No wasted retries on deploys; slower shutdowns (bounded by grace).
