from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from bpcommon.errors import Conflict, NotFound, Unauthorized

from ..db.models import Delivery, DeliveryAttempt, Endpoint, Event
from ..services.endpoints import EndpointCreate, EndpointService, EndpointUpdate, endpoint_view
from ..services.events import EventCreate, publish


async def require_token(request: Request, authorization: str | None = Header(default=None)) -> None:
    if not authorization or not hmac.compare_digest(authorization, f"Bearer {request.app.state.settings.api_token}"):
        raise Unauthorized("Bearer token required")


async def session(request: Request):
    async with request.app.state.sessionmaker() as s, s.begin():
        yield s


router = APIRouter(dependencies=[Depends(require_token)])


def _svc(request: Request, s) -> EndpointService:
    cfg = request.app.state.settings
    return EndpointService(s, allow_private=cfg.allow_private_destinations,
                           default_rate=cfg.default_rate_limit_per_second)


@router.post("/endpoints", status_code=201, tags=["endpoints"])
async def create_endpoint(body: EndpointCreate, request: Request, s=Depends(session)):
    e = await _svc(request, s).create(body)
    return endpoint_view(e, include_secret=True)   # secret shown on creation (and via /secret)


@router.get("/endpoints", tags=["endpoints"])
async def list_endpoints(request: Request, s=Depends(session)):
    return {"endpoints": [endpoint_view(e) for e in await _svc(request, s).list()]}


@router.get("/endpoints/{endpoint_id}", tags=["endpoints"])
async def get_endpoint(endpoint_id: str, request: Request, s=Depends(session)):
    return endpoint_view(await _svc(request, s).get(endpoint_id))


@router.patch("/endpoints/{endpoint_id}", tags=["endpoints"])
async def update_endpoint(endpoint_id: str, body: EndpointUpdate, request: Request, s=Depends(session)):
    return endpoint_view(await _svc(request, s).update(endpoint_id, body))


@router.get("/endpoints/{endpoint_id}/secret", tags=["endpoints"])
async def get_secret(endpoint_id: str, request: Request, s=Depends(session)):
    e = await _svc(request, s).get(endpoint_id)
    return {"secret": e.secret, "previous_secret_expires_at": e.previous_secret_expires_at}


class Rotate(BaseModel):
    grace_seconds: int = Field(default=24 * 3600, ge=0, le=7 * 24 * 3600)


@router.post("/endpoints/{endpoint_id}/rotate-secret", tags=["endpoints"])
async def rotate(endpoint_id: str, body: Rotate, request: Request, s=Depends(session)):
    e = await _svc(request, s).rotate_secret(endpoint_id, body.grace_seconds)
    return {"secret": e.secret, "previous_secret_expires_at": e.previous_secret_expires_at}


@router.post("/events", status_code=201, tags=["events"])
async def create_event(body: EventCreate, response: Response, s=Depends(session)):
    event, n, created = await publish(s, body)
    if not created:
        response.status_code = 200
    return {"created": created, "event": {"id": event.id, "type": event.type}, "deliveries": n}


@router.get("/events/{event_id}", tags=["events"])
async def get_event(event_id: str, s=Depends(session)):
    e = await s.get(Event, event_id)
    if e is None:
        raise NotFound("event not found")
    rows = (await s.scalars(select(Delivery).where(Delivery.event_id == event_id))).all()
    return {"id": e.id, "type": e.type, "payload": e.payload, "created_at": e.created_at,
            "deliveries": [_delivery_view(d) for d in rows]}


def _delivery_view(d: Delivery) -> dict:
    return {"id": d.id, "event_id": d.event_id, "endpoint_id": d.endpoint_id, "status": d.status,
            "attempts": d.attempts, "next_attempt_at": d.next_attempt_at, "last_status_code": d.last_status_code,
            "last_error": d.last_error, "delivered_at": d.delivered_at, "created_at": d.created_at}


@router.get("/deliveries", tags=["deliveries"])
async def list_deliveries(s=Depends(session), status: str | None = None, endpoint_id: str | None = None,
                          limit: int = Query(50, ge=1, le=500)):
    q = select(Delivery).order_by(Delivery.id.desc()).limit(limit)
    if status:
        q = q.where(Delivery.status == status)
    if endpoint_id:
        q = q.where(Delivery.endpoint_id == endpoint_id)
    return {"deliveries": [_delivery_view(d) for d in (await s.scalars(q)).all()]}


@router.get("/deliveries/{delivery_id}", tags=["deliveries"])
async def get_delivery(delivery_id: int, s=Depends(session)):
    d = await s.get(Delivery, delivery_id)
    if d is None:
        raise NotFound("delivery not found")
    attempts = (await s.scalars(select(DeliveryAttempt).where(DeliveryAttempt.delivery_id == delivery_id)
                                .order_by(DeliveryAttempt.attempt))).all()
    return {**_delivery_view(d), "log": [
        {"attempt": a.attempt, "started_at": a.started_at, "duration_ms": a.duration_ms,
         "status_code": a.status_code, "outcome": a.outcome, "error": a.error,
         "response_snippet": a.response_snippet} for a in attempts]}


@router.post("/deliveries/{delivery_id}/retry", tags=["deliveries"])
async def retry_delivery(delivery_id: int, s=Depends(session)):
    """Replay a dead (or delivered) delivery now. Receivers dedupe on webhook-id, so replaying a
    delivered one is safe for well-behaved receivers."""
    res = await s.execute(update(Delivery).where(Delivery.id == delivery_id, Delivery.status.in_(["dead", "succeeded"]))
                          .values(status="pending", attempts=0, next_attempt_at=func.now(), last_error=None))
    if res.rowcount == 0:
        raise Conflict("delivery not found or still pending/in flight")
    return {"requeued": True}


@router.post("/endpoints/{endpoint_id}/replay-dead", tags=["deliveries"])
async def replay_dead(endpoint_id: str, s=Depends(session)):
    res = await s.execute(update(Delivery).where(Delivery.endpoint_id == endpoint_id, Delivery.status == "dead")
                          .values(status="pending", attempts=0, next_attempt_at=func.now()))
    return {"requeued": res.rowcount}


@router.get("/stats", tags=["ops"])
async def stats(s=Depends(session)):
    rows = (await s.execute(select(Delivery.status, func.count()).group_by(Delivery.status))).all()
    eps = (await s.execute(select(Endpoint.enabled, func.count()).group_by(Endpoint.enabled))).all()
    oldest = await s.scalar(select(func.min(Delivery.next_attempt_at)).where(Delivery.status == "pending"))
    return {"deliveries": {k: v for k, v in rows}, "endpoints": {"enabled" if k else "disabled": v for k, v in eps},
            "oldest_pending_due_at": oldest}
