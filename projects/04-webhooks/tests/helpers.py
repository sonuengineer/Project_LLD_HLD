from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select, update

from webhooks.db.models import Delivery, DeliveryAttempt, Endpoint
from webhooks.dispatcher.dispatcher import Dispatcher
from webhooks.receiver.app import app as receiver_app
from webhooks.services.endpoints import EndpointCreate, EndpointService
from webhooks.services.events import EventCreate, publish

from .conftest import make_settings


async def add_endpoint(sm, url="http://receiver/webhook", types=("*",), rate=1000.0):
    async with sm() as s, s.begin():
        e = await EndpointService(s, allow_private=True, default_rate=rate).create(
            EndpointCreate(url=url, event_types=list(types), rate_limit_per_second=rate))
        return e.id, e.secret


async def emit(sm, type_="order.paid", payload=None, key=None):
    async with sm() as s, s.begin():
        ev, n, created = await publish(s, EventCreate(type=type_, payload=payload or {"amount": 100}, idempotency_key=key))
        return ev.id, n, created


def receiver(secrets, fail_next=0):
    receiver_app.state.secrets = list(secrets)
    receiver_app.state.seen = {}
    receiver_app.state.duplicates = 0
    receiver_app.state.fail_next = fail_next
    return httpx.ASGITransport(app=receiver_app)


def dispatcher(sm, limiter, transport, **cfg):
    return Dispatcher(make_settings(**cfg), sm, limiter, transport=transport, worker_id=cfg.pop("wid", "d1"))


async def make_all_due(sm):
    """Retries are scheduled in the future; tests fast-forward instead of sleeping."""
    async with sm() as s, s.begin():
        await s.execute(update(Delivery).where(Delivery.status == "pending")
                        .values(next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=1)))


async def drain(sm, d, rounds=20):
    for _ in range(rounds):
        await make_all_due(sm)
        if await d.run_once() == 0:
            return


async def deliveries(sm):
    async with sm() as s:
        return (await s.scalars(select(Delivery).order_by(Delivery.id))).all()


async def attempts(sm, delivery_id):
    async with sm() as s:
        return (await s.scalars(select(DeliveryAttempt).where(DeliveryAttempt.delivery_id == delivery_id)
                                .order_by(DeliveryAttempt.attempt))).all()


async def endpoint(sm, eid):
    async with sm() as s:
        return await s.get(Endpoint, eid)
