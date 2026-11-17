# Project 2 -- minidis: a Redis-like In-Memory Database

A from-scratch in-memory database in Python asyncio that speaks the **real Redis wire protocol
(RESP2 and RESP3)**, so the official `redis-py` client, `redis-cli` and `redis-benchmark` work against it.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| TCP server, many concurrent clients, pipelining | `minidis/server.py::Server._handle_client` | `tests/test_concurrency.py` |
| RESP2 + RESP3 (HELLO negotiation), incremental parser, inline commands | `minidis/protocol.py` | `tests/test_protocol.py`, `test_resp3_client` |
| Strings: GET SET(NX/XX/EX/PX/EXAT/PXAT/KEEPTTL/GET) SETNX MGET MSET INCR/DECR(BY) APPEND STRLEN GETDEL | `commands/strings.py` | `test_strings`, `test_set_options` |
| Keys: DEL UNLINK EXISTS TYPE EXPIRE PEXPIRE EXPIREAT PEXPIREAT TTL PTTL PERSIST KEYS SCAN DBSIZE FLUSHDB RENAME | `commands/keys.py` | `test_ttl_semantics`, `test_keys_scan_dbsize` |
| Lists (deque), Sets, Hashes | `commands/lists.py`, `sets.py`, `hashes.py` | `test_lists`, `test_sets`, `test_hashes` |
| Lazy + active (sampled, Redis-style) expiration | `keyspace.py::Keyspace.active_expire_cycle` | `tests/test_expiry_eviction.py` |
| maxmemory + eviction: noeviction, allkeys-lru (exact), volatile-lru (sampled), volatile-ttl | `keyspace.py::evict_until_fits` | same |
| Snapshots (binary, CRC32, atomic rename), SAVE / BGSAVE / auto-save rules | `persistence/snapshot.py` | `tests/test_persistence.py` |
| AOF with always / everysec / no fsync, truncated-tail recovery, BGREWRITEAOF with rewrite buffer | `persistence/aof.py` | same |
| Recovery on restart (AOF preferred over snapshot) | `server.py::_load_from_disk` | `test_aof_restart_without_snapshot`, `test_snapshot_restart` |
| Master -> replica async replication (full sync + command stream, ACK offsets, read-only replica, promote) | `replication.py`, `server.py::_serve_replica` | `tests/test_replication.py` |
| Memory monitoring: INFO memory/stats/persistence/replication, MEMORY USAGE | `server.py::info` | `test_info_and_memory` |

52 tests, all passing. Benchmarks vs real Redis in [TESTING.md](TESTING.md).

## Run

```bash
cd projects/02-mini-redis
../../.venv/Scripts/python -m minidis --port 6380 --appendonly yes --dir ./data
redis-cli -p 6380 set hello world        # or: python -c "import redis; print(redis.Redis(port=6380).get('hello'))"
../../.venv/Scripts/python -m pytest -q
```

Docker (master + replica, plus real Redis for benchmarks):

```bash
docker compose up -d --build
docker compose run --rm cli redis-cli -h master -p 6380 set k v
docker compose run --rm cli redis-cli -h replica -p 6380 get k
bash bench/compare.sh
```

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations (honest list)

- Single database (db 0); no MULTI/EXEC, Pub/Sub, Lua, sorted sets, streams, blocking pops, cluster mode.
- No partial resync (PSYNC/backlog): every replica reconnect is a full sync.
- No AUTH / ACL / TLS (see SECURITY.md) -- bind to localhost or a private network only.
- `used_memory` is an estimate (payload bytes + fixed per-entry overhead), not real process RSS.
- BGSAVE serializes in the event loop (no fork on Windows); only the disk write is backgrounded.
- About 4-6x slower than real Redis on the same machine (Python vs C); see TESTING.md.
