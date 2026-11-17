# Trade-offs -- minidis

1. **Single-threaded command execution.** No locks and every command is atomic, but one slow
   command (KEYS on a big DB, DEBUG SLEEP, a huge LRANGE) blocks every client. Redis made the same
   choice and later added threaded I/O, never threaded execution.
2. **Python asyncio instead of C.** Readable and testable; ~4-6x slower than real Redis on the same
   machine (TESTING.md). The architecture, not the language, is what this project teaches.
3. **Exact LRU (allkeys-lru) vs sampled LRU (volatile-lru).** Exact LRU via OrderedDict costs a
   `move_to_end` on every read. Redis uses sampling to avoid per-key linked-list overhead; we
   implement both so the difference can be discussed with code.
4. **Estimated memory accounting.** Deterministic and cheap; not real RSS. Real allocators
   fragment memory, so production systems must watch RSS too.
5. **AOF relative-to-absolute TTL rewriting.** Makes replay deterministic; costs one extra AOF entry
   per expiring SET.
6. **AOF preferred over snapshot on startup.** AOF is usually more complete; snapshots load faster.
   Real Redis 7 combines both (RDB preamble + AOF tail); we keep them separate for clarity.
7. **BGSAVE without fork.** Serialization happens in the loop (consistent but blocking for big
   datasets); disk I/O runs in a thread. fork + copy-on-write would avoid the pause but is not
   available on Windows and doubles memory in the worst case.
8. **Full resync only.** Simple and always correct; expensive for large datasets on flaky
   networks. PSYNC with a backlog is the production fix.
9. **Asynchronous replication.** Low write latency; acknowledged writes can be lost on failover.
10. **Batched replication writes.** One socket write per loop tick instead of per command: measured
    2-3.5x faster pipelined writes, at the cost of a tiny extra delay before replicas see a write.
11. **`appendfsync always` with group commit.** One fsync per client batch rather than per command:
    still "nothing acknowledged is lost", much cheaper under pipelining.
