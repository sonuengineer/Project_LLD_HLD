# Deployment -- minidis

## Container

`Dockerfile` (context = repo root): python:3.12-slim, no third-party runtime deps, non-root user,
data volume `/data`, default command enables AOF.

```bash
docker compose up -d --build          # master on 127.0.0.1:56380, replica on 127.0.0.1:56381
docker compose logs -f master
docker compose down                    # add -v to delete data volumes
```

## Configuration

See `.env.example` / `python -m minidis --help`. Important choices:

| Setting | Recommendation |
|---|---|
| `--appendonly yes --appendfsync everysec` | default durability trade-off (lose <= ~1s) |
| `--save "..."` | keep snapshots too: faster restarts and easy backups |
| `--maxmemory` + policy | always set in shared hosts; `allkeys-lru` for caches, `noeviction` for data you can't lose |
| `--host` | never 0.0.0.0 on an untrusted network (no auth) |

## Operations

- Backups: copy `dump.mdb` (consistent thanks to atomic rename) after `BGSAVE` completes.
- Compaction: run `BGREWRITEAOF` when `aof_current_size` grows far beyond the dataset.
- Monitoring: poll `INFO` (`used_memory`, `evicted_keys`, `expired_keys`, `rdb_last_bgsave_status`,
  `master_link_status`, `lag_bytes`).
- Failover (manual): `REPLICAOF NO ONE` on the replica, point clients at it, then
  `REPLICAOF <new-master> 6380` on the old master when it returns (it will full-sync).
- Graceful shutdown: SIGTERM -> AOF fsync + final snapshot if dirty (Linux; on Windows use Ctrl+C).
