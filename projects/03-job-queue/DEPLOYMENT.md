# Deployment -- Distributed Job Queue

One image, two roles: API (`uvicorn jobqueue.main:app`) and worker (`python -m jobqueue.worker`),
plus a one-shot `migrate` service (`alembic upgrade head`) that must finish before API/workers start.

```bash
docker compose up -d --build                 # api 127.0.0.1:58003, 3 workers
docker compose up -d --scale worker=6        # scale consumers
docker compose logs -f worker
```

## Production checklist

1. **Redis durability**: AOF `everysec` (compose sets it) + a replica / managed Redis. The queue
   lives in Redis; without persistence a restart loses queued jobs.
2. **Worker sizing**: `--concurrency` = how many jobs one process runs at once (I/O-bound handlers:
   high; CPU-bound: 1 per core and move the CPU work to a process pool).
3. **Separate worker pools per queue class** (e.g. dedicated `critical` workers) so a flood of low
   priority work can't delay critical jobs.
4. **Graceful deploys**: `stop_grace_period` >= longest normal job; SIGTERM drains in-flight jobs.
5. **Alerts**: `dead` count growing, `ready` backlog age, `reaped` counter (crashing/stalling
   workers), workers with `alive=false`, `stale_acks > 0` (leases too short or blocked loops).
6. **Secrets** via env (`JQ_API_TOKEN`, DB password); never in job payloads.
7. **Migrations** run as a separate step, never on app start in multiple replicas concurrently.
