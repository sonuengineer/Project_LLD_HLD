# Testing -- minidis

```bash
cd projects/02-mini-redis
../../.venv/Scripts/python -m pytest -q        # 52 tests, ~10s
```

Each test starts a real server on a random port (`port=0`) with a temp data dir and talks to it with
the **official redis-py client** -- so the tests also prove protocol compatibility.

| File | Count | Covers |
|---|---|---|
| `test_protocol.py` | 7 | partial frames byte-by-byte, pipelining, binary safety, inline, malformed input, limits, RESP2/RESP3 encoding |
| `test_commands.py` | 10 | all command groups, SET options, TTL semantics, WRONGTYPE / arity / unknown errors, RESP3 client, SCAN, INFO/MEMORY |
| `test_expiry_eviction.py` | 12 | lazy + active expiry with a fake clock, replica expiry semantics, DEL propagation, LRU / volatile-ttl / volatile-lru, memory accounting, OOM, hot key survival |
| `test_persistence.py` | 11 | snapshot restart, BGSAVE, corruption, AOF restart x3 fsync modes, absolute TTL in AOF, truncated tail, rewrite with concurrent writes, atomic write, minimal rewrite, dirty counter |
| `test_concurrency.py` | 4 | 50 clients x 200 INCR = exactly 10000, 1000-command pipeline, slow command blocks others, 200 concurrent connections |
| `test_replication.py` | 6 | full sync + stream, read-only, expiry DEL, reconnect after master restart, promote, ACK offsets |

## Bugs found by tests (and fixed)

1. **Replica memory leak**: a `DEL` from the master for an already logically-expired key was ignored
   on the replica (it returned early as "already gone"), so expired keys were never freed on replicas.
   Regression: `test_replica_physically_deletes_on_master_del`.
2. **Dirty counter went to -1 after BGSAVE** (reset to 0 and then subtracted again).
   Regression: `test_writes_during_bgsave_stay_dirty`.
3. **`BGSAVE SCHEDULE` rejected** (redis-py sends it) -- arity fixed.
4. **redis-py 8 negotiates RESP3 by default** (`HELLO 3`); minidis initially only spoke RESP2 and
   every connection failed. RESP3 support added.
5. Found while writing the interview bank (code review), confirmed by running, fixed with regressions:
   - `lag_bytes` used the wrong baseline for replicas attached after earlier writes (a caught-up replica
     showed `lag_bytes: 570`). Fix: per-replica `repl_base`. Test: `test_lag_bytes_is_zero_for_caught_up_replica_attached_late`.
   - Under `noeviction`, `DEL` was refused with OOM, so memory could never be freed. Fix: `may_grow`
     command flag (Redis' `denyoom`). Test: extended `test_noeviction_returns_oom_error`.
   - Integer parsing accepted `" 5"`, `+5`, `1_000` (Python `int()`), unlike Redis. Fix: strict `to_int`.
     Test: `test_integer_parsing_is_strict_like_redis`.
6. Test-environment finding: on Windows, connecting to `localhost` tries IPv6 `::1` first and costs
   ~2s per connection against an IPv4 listener. Using `127.0.0.1` cut the suite from 94s to 11s.

## Benchmarks (real runs, 2026-11-16)

Tool: official `redis-benchmark` (C) from `redis:7-alpine`, in the same Docker network as both
servers. Windows 11 + Docker Desktop (12 vCPU VM shared with ~25 other containers). Both servers
with AOF `everysec`. `-n 50000 -c 50`. Numbers are requests/second.

### Real Redis 7 vs minidis (before the replication batching fix, replica attached to minidis)

| Command | Redis P=1 | minidis P=1 | Redis P=16 | minidis P=16 |
|---|---|---|---|---|
| SET | 30,102 | 4,914 | 207,469 | 11,249 |
| GET | 34,578 | 10,600 | 294,118 | 74,184 |
| INCR | 48,450 | 4,722 | 228,311 | 14,966 |
| LPUSH | 48,077 | 4,875 | 130,208 | 16,077 |
| HSET | 36,982 | 5,807 | 235,849 | 16,926 |

Writes were 2-6x slower than reads. Investigation: stopping the replica doubled pipelined SET
(11.2k -> 23.2k), pointing at one socket write per propagated command. Fix: batch the replication
stream and flush once per event-loop tick (`Server._flush_replication`).

### minidis after the fix (replica attached, verified lag_bytes=0 afterwards)

| Command | P=1 | P=16 |
|---|---|---|
| SET | 8,169 | 34,698 |
| GET | 13,277 | 53,135 |
| INCR | 9,497 | 57,143 |
| LPUSH | 9,660 | 40,290 |
| HSET | 9,285 | 43,253 |

Run-to-run variance on this shared machine is large (GET P=16 ranged 32k-74k across runs), so read
the tables as "same order of magnitude", not exact. Real Redis remains ~4-6x faster, as expected
for C vs CPython.

Reproduce: `bash bench/compare.sh` (env `N`, `C` to change requests/clients).
