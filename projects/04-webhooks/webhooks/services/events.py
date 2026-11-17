"""Publishing: insert the event and fan out one delivery row per subscribed endpoint, in ONE
transaction. This is the transactional outbox: if the commit succeeds, every delivery will be
attempted; if it fails, nothing was promised. No 'saved the event but lost the queue message'."""
from __future__ import annotations

import secrets
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Delivery, Endpoint, Event


class EventCreate(BaseModel):
    type: str = Field(pattern=r"^[a-z0-9_]+(\.[a-z0-9_]+)*$", max_length=100)
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, max_length=200)


async def publish(s: AsyncSession, body: EventCreate) -> tuple[Event, int, bool]:
    """Returns (event, deliveries_created, created). Same idempotency key -> original event."""
    if body.idempotency_key:
        existing = await s.scalar(select(Event).where(Event.idempotency_key == body.idempotency_key))
        if existing:
            n = await s.scalar(select(func.count()).select_from(Delivery).where(Delivery.event_id == existing.id))
            return existing, n, False
    event_id = "evt_" + secrets.token_hex(12)
    stmt = (insert(Event).values(id=event_id, type=body.type, payload=body.payload,
                                 idempotency_key=body.idempotency_key)
            .on_conflict_do_nothing(index_elements=["idempotency_key"]).returning(Event.id))
    if (await s.execute(stmt)).scalar_one_or_none() is None:
        # Lost a race with a concurrent request using the same key: return the winner.
        existing = await s.scalar(select(Event).where(Event.idempotency_key == body.idempotency_key))
        return existing, 0, False
    # Postgres array overlap (&&): endpoint subscribes to this type or to "*". A GIN index on
    # event_types would serve this at scale.
    subscribed = select(Endpoint.id).where(Endpoint.event_types.overlap([body.type, "*"]))
    endpoint_ids = (await s.scalars(subscribed)).all()
    if endpoint_ids:
        await s.execute(insert(Delivery), [{"event_id": event_id, "endpoint_id": eid} for eid in endpoint_ids])
    event = await s.get(Event, event_id)
    return event, len(endpoint_ids), True
