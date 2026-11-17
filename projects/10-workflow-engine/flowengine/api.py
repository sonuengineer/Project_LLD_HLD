from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import text

from bpcommon.errors import NotFound, Unauthorized, Unprocessable

from . import store
from .runtime import WORKFLOWS, NonDeterminismError, replay

router = APIRouter()


class StartIn(BaseModel):
    workflow_type: str
    workflow_id: str = Field(min_length=1, max_length=200)
    input: Any = Field(default_factory=dict)
    task_queue: str = "default"


@router.post("/workflows", status_code=201, tags=["workflows"])
async def start(body: StartIn, request: Request):
    if body.workflow_type not in WORKFLOWS:
        raise Unprocessable(f"unknown workflow type {body.workflow_type!r}", details={"known": sorted(WORKFLOWS)})
    return await store.start_workflow(request.app.state.sm, body.workflow_type, body.workflow_id, body.input, body.task_queue)


@router.get("/workflows", tags=["workflows"])
async def list_workflows(request: Request, status: str | None = None, limit: int = Query(100, ge=1, le=1000)):
    q = "SELECT workflow_id, workflow_type, status, task_queue, error, last_event_id, created_at, closed_at FROM workflows"
    params: dict = {"l": limit}
    if status:
        q += " WHERE status = :s"
        params["s"] = status
    async with request.app.state.sm() as s:
        rows = (await s.execute(text(q + " ORDER BY created_at DESC LIMIT :l"), params)).mappings().all()
    return {"workflows": [dict(r) for r in rows]}


@router.get("/workflows/{workflow_id}", tags=["workflows"])
async def describe(workflow_id: str, request: Request):
    return await store.describe(request.app.state.sm, workflow_id)


@router.get("/workflows/{workflow_id}/history", tags=["workflows"])
async def history(workflow_id: str, request: Request):
    return {"events": await store.history(request.app.state.sm, workflow_id)}


class SignalIn(BaseModel):
    payload: Any = None


@router.post("/workflows/{workflow_id}/signals/{name}", tags=["workflows"])
async def signal(workflow_id: str, name: str, body: SignalIn, request: Request):
    await store.signal(request.app.state.sm, workflow_id, name, body.payload)
    return {"signalled": name}


class CancelIn(BaseModel):
    reason: str = ""


@router.post("/workflows/{workflow_id}/cancel", tags=["workflows"])
async def cancel(workflow_id: str, body: CancelIn, request: Request):
    await store.cancel(request.app.state.sm, workflow_id, body.reason)
    return {"cancel_requested": True}


@router.post("/workflows/{workflow_id}/retry-task", tags=["operations"])
async def retry_task(workflow_id: str, request: Request, x_admin_token: str | None = Header(default=None)):
    """Re-queue the workflow task of a blocked workflow (after fixing the code). Operator-only (X-Admin-Token);
    run replay-check first to confirm the new code replays the history."""
    # constant-time comparison: != leaks how many leading characters matched via response timing
    if not x_admin_token or not hmac.compare_digest(x_admin_token, request.app.state.settings.admin_token):
        raise Unauthorized("admin token required")
    return await store.retry_workflow_task(request.app.state.sm, workflow_id)


@router.post("/workflows/{workflow_id}/replay-check", tags=["workflows"])
async def replay_check(workflow_id: str, request: Request):
    """Re-run the CURRENT workflow code against the recorded history: run this in CI before deploying a change to
    workflow code -- a NonDeterminismError means running workflows would break."""
    wf = await store.describe(request.app.state.sm, workflow_id)
    events = await store.history(request.app.state.sm, workflow_id)
    fn = WORKFLOWS.get(wf["workflow_type"])
    if fn is None:
        raise NotFound("workflow type not registered in this process")
    try:
        r = await replay(fn, workflow_id, str(wf["run_id"]), events)
    except NonDeterminismError as exc:
        return {"deterministic": False, "error": str(exc)}
    return {"deterministic": True, "replayed_events": len(events), "replay_status": r.status}


@router.get("/workers", tags=["workers"])
async def workers(request: Request):
    async with request.app.state.sm() as s:
        rows = (await s.execute(text("SELECT *, extract(epoch FROM now() - last_heartbeat) AS seconds_since_heartbeat "
                                     "FROM workers ORDER BY worker_id"))).mappings().all()
    return {"workers": [dict(r) for r in rows]}


@router.get("/stats", tags=["ops"])
async def stats(request: Request):
    async with request.app.state.sm() as s:
        wf = dict((await s.execute(text("SELECT status, count(*) FROM workflows GROUP BY status"))).all())
        act = dict((await s.execute(text("SELECT status, count(*) FROM activity_tasks GROUP BY status"))).all())
        backlog = await s.scalar(text("SELECT count(*) FROM workflows WHERE status = 'running' AND needs_task"))
    return {"workflows": wf, "activities": act, "workflow_task_backlog": backlog}
