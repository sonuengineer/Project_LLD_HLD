from __future__ import annotations

import hmac
import json
import time

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from bpcommon.errors import Conflict, NotFound, Unauthorized

from ..core.models import EnqueueRequest, JobStatus, ScheduleRequest


async def require_token(request: Request, authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {request.app.state.settings.api_token}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise Unauthorized("Bearer token required")


router = APIRouter(dependencies=[Depends(require_token)])


def _q(request: Request):
    return request.app.state.queue


@router.post("/jobs", status_code=201, tags=["jobs"])
async def enqueue(body: EnqueueRequest, request: Request, response: Response):
    job_id, created = await _q(request).enqueue(body)
    if not created:
        response.status_code = 200  # idempotent replay: same key -> the original job
    job = await _q(request).get(job_id)
    return {"created": created, "job": job.model_dump() if job else {"id": job_id}}


@router.get("/jobs/{job_id}", tags=["jobs"])
async def get_job(job_id: str, request: Request):
    job = await _q(request).get(job_id)
    if job is None:
        raise NotFound("job not found (or expired after retention)")
    return job.model_dump()


@router.get("/jobs", tags=["jobs"])
async def list_jobs(request: Request, queue: str = "default", status: JobStatus = JobStatus.QUEUED,
                    limit: int = Query(50, ge=1, le=500)):
    q = _q(request)
    ids = await q.list_ids(queue, status, limit)
    jobs = [j for j in [await q.get(i) for i in ids] if j]
    return {"queue": queue, "status": status, "jobs": [j.model_dump() for j in jobs]}


@router.delete("/jobs/{job_id}", tags=["jobs"])
async def cancel_job(job_id: str, request: Request):
    q = _q(request)
    job = await q.get(job_id)
    if job is None:
        raise NotFound("job not found")
    if not await q.cancel(job):
        raise Conflict(f"job is {job.status}; only queued/delayed jobs can be cancelled")
    return {"cancelled": True}


@router.get("/queues", tags=["queues"])
async def queues(request: Request):
    q = _q(request)
    return {"queues": [await q.queue_stats(name) for name in await q.queues()]}


@router.get("/dlq", tags=["dead letter queue"])
async def dlq(request: Request, queue: str = "default", limit: int = Query(50, ge=1, le=500)):
    q = _q(request)
    ids = await q.list_ids(queue, JobStatus.DEAD, limit)
    return {"queue": queue, "jobs": [j.model_dump() for j in [await q.get(i) for i in ids] if j]}


@router.post("/dlq/{job_id}/requeue", tags=["dead letter queue"])
async def requeue(job_id: str, request: Request):
    q = _q(request)
    job = await q.get(job_id)
    if job is None:
        raise NotFound("job not found")
    if not await q.requeue_dead(job.queue, job_id):
        raise Conflict(f"job is {job.status}, not dead")
    return {"requeued": True}


@router.post("/dlq/requeue-all", tags=["dead letter queue"])
async def requeue_all(request: Request, queue: str = "default", type: str | None = None):
    q = _q(request)
    n = 0
    for job_id in await q.list_ids(queue, JobStatus.DEAD, 10_000):
        job = await q.get(job_id)
        if job and (type is None or job.type == type) and await q.requeue_dead(queue, job_id):
            n += 1
    return {"requeued": n}


@router.get("/workers", tags=["workers"])
async def workers(request: Request):
    """Health: a worker is 'alive' while its heartbeat key (TTL = 3 x interval) exists."""
    q = _q(request)
    raw = await q.r.hgetall(f"{q.p}workers")
    out = []
    for wid, info in raw.items():
        d = json.loads(info)
        d["alive"] = bool(await q.r.exists(f"{q.p}worker:{wid.decode()}:alive"))
        d["seconds_since_heartbeat"] = round(time.time() - d["last_heartbeat"], 1)
        out.append(d)
    return {"workers": sorted(out, key=lambda d: d["id"])}


@router.delete("/workers/{worker_id}", tags=["workers"])
async def forget_worker(worker_id: str, request: Request):
    q = _q(request)
    await q.r.hdel(f"{q.p}workers", worker_id)
    return {"removed": True}


@router.post("/schedules", status_code=201, tags=["schedules"])
async def put_schedule(body: ScheduleRequest, request: Request):
    return await _q(request).put_schedule(body)


@router.get("/schedules", tags=["schedules"])
async def list_schedules(request: Request):
    return {"schedules": await _q(request).list_schedules()}


@router.delete("/schedules/{name}", tags=["schedules"])
async def delete_schedule(name: str, request: Request):
    if not await _q(request).delete_schedule(name):
        raise NotFound("schedule not found")
    return {"deleted": True}


@router.get("/handlers", tags=["jobs"])
async def handlers():
    from ..handlers.builtin import registry
    return {"types": registry.names()}
