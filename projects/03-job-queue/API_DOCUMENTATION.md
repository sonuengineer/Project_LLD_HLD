# API -- Distributed Job Queue

Auth: `Authorization: Bearer <JQ_API_TOKEN>` on everything except `/healthz`, `/metrics`, `/dashboard`.
OpenAPI: `/docs`. Errors use the shared shape `{"error": {"code", "message", "details", "request_id"}}`.

| Method | Path | Notes |
|---|---|---|
| POST | `/jobs` | body below; 201 created, **200 if idempotency_key matched an existing job** |
| GET | `/jobs/{id}` | full job incl. attempt errors; 404 after retention |
| GET | `/jobs?queue=&status=&limit=` | status: queued, delayed, active, dead, succeeded |
| DELETE | `/jobs/{id}` | cancel queued/delayed; 409 if active/finished |
| GET | `/queues` | per queue: ready, delayed, active, dead + counters |
| GET | `/dlq?queue=` | dead jobs with last errors |
| POST | `/dlq/{id}/requeue` | replay one (attempts reset); 409 if not dead |
| POST | `/dlq/requeue-all?queue=&type=` | bulk replay |
| GET | `/workers` | heartbeat info, `alive`, `seconds_since_heartbeat` |
| DELETE | `/workers/{id}` | forget a dead worker entry |
| POST/GET/DELETE | `/schedules` | recurring jobs |
| GET | `/handlers` | registered job types |

## Enqueue body

```json
{
  "type": "email.send",
  "payload": {"to": "a@example.com", "subject": "Welcome"},
  "queue": "default",
  "priority": 5,
  "delay_seconds": null,
  "run_at_ms": null,
  "max_attempts": 5,
  "timeout_seconds": 30,
  "backoff_base_seconds": 2,
  "backoff_max_seconds": 600,
  "idempotency_key": "welcome-email:user-42"
}
```

Validation: `type` `^[a-z0-9_.]{1,64}$`, priority 0-9 (9 = most urgent), not both `delay_seconds` and `run_at_ms`.

## Schedule body

```json
{"name": "nightly-report", "interval_seconds": 86400, "start_in_seconds": 0,
 "job": {"type": "report.generate", "queue": "low"}}
```

## Worker CLI

`python -m jobqueue.worker --queues critical,default,low --concurrency 16 [--worker-id x]`
Queue order = strict priority. Env: see `.env.example`.
