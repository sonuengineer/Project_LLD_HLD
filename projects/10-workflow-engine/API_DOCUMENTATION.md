# API -- flowengine

OpenAPI at `/docs`. (No auth: internal service in this demo.)

| Method | Path | Notes |
|---|---|---|
| POST | `/workflows` | `{workflow_type, workflow_id, input, task_queue?}` -> `{run_id, started}` (idempotent on workflow_id) |
| GET | `/workflows?status=` | list |
| GET | `/workflows/{id}` | status, result, error, activities (attempts, last error) |
| GET | `/workflows/{id}/history` | full event history |
| POST | `/workflows/{id}/signals/{name}` | `{payload}` |
| POST | `/workflows/{id}/cancel` | `{reason}` -> CancelRequested delivered into the workflow |
| POST | `/workflows/{id}/replay-check` | replay current code against history: `{deterministic: bool}` (CI before deploys) |
| POST | `/workflows/{id}/retry-task` | operator (`X-Admin-Token`): re-queue the workflow task of a workflow blocked by a replay error, after deploying fixed code; 409 if not running |
| GET | `/workers` | registered workers + heartbeat age |
| GET | `/stats` | counts by status, workflow-task backlog |
| GET | `/dashboard` | executions + history timeline |

## Writing a workflow

```python
from flowengine.runtime import workflow, RetryPolicy, ActivityError

@workflow("order_processing")
async def order_processing(ctx, inp):
    res = await ctx.execute_activity("reserve_inventory", inp["items"], retry=RetryPolicy(maximum_attempts=3))
    try:
        charge = await ctx.execute_activity("charge_payment", inp["amount"], inp["card"])
    except ActivityError:
        await ctx.execute_activity("release_inventory", res["reservation_id"])
        raise
    approved = await ctx.wait_signal("approve", timeout=3600)   # durable: survives restarts
    await ctx.sleep(24 * 3600)                                  # durable timer
    return {"ok": True}
```

Worker: `python -m flowengine --task-queue default --activity-concurrency 16`.
