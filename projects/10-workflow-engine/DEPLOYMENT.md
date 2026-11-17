# Deployment -- flowengine

```bash
docker compose up -d --build     # postgres (volume), migrate, api (127.0.0.1:58010), 2 workers
python demo.py http://127.0.0.1:58010
docker compose up -d --scale worker=4
```

Operational rules:
1. **Deploying workflow code changes:** run `POST /workflows/{id}/replay-check` (or a test that replays recorded
   histories) in CI. Changing the order/type of steps breaks running workflows; add new steps only for new runs
   (versioning is a documented gap).
2. Workers are stateless: scale by count; `stop_grace_period` >= longest activity you want to drain.
3. Alert on: workflows with `error` set (non-determinism), activity attempts climbing, timer lag, workflow-task backlog (`/stats`).
4. Retention: archive histories of closed workflows after N days.
