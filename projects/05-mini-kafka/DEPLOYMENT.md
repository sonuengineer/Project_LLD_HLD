# Deployment -- minikafka

```bash
docker compose up -d --build      # API + 3 in-process brokers, data on volume mk-data
open http://127.0.0.1:58005/dashboard
python demo.py http://127.0.0.1:58005
docker compose down               # add -v to wipe data
```

Env: `MK_DATA_DIR`, `MK_BROKERS`, `MK_ADMIN_TOKEN`, `MK_LOG_LEVEL`, `MK_LOG_JSON` (`.env.example`).

Run with ONE uvicorn worker: the cluster lives inside the process; multiple workers would mean multiple
independent clusters on the same data directory (corruption).

## Operating notes (map to real Kafka)

- Watch under-replicated partitions (ISR < replicas) and offline partitions on the dashboard.
- Consumer lag = HW - committed (per partition) via `/groups/{g}`; alert when it grows.
- Size retention by disk and by replay needs; remember retention is per segment.
- Recommended durable topic: `replication_factor=3, min_insync_replicas=2`, producers `acks=all`.
