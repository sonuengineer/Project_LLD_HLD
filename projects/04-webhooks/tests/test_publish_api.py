import contextlib

import httpx
import pytest
from sqlalchemy import func, select

from webhooks.db.models import Delivery, Event
from webhooks.main import create_app

from .conftest import make_settings
from .helpers import add_endpoint, emit

AUTH = {"Authorization": "Bearer test-token"}


async def test_fanout_only_to_subscribers(sm):
    await add_endpoint(sm, types=["order.paid"])
    await add_endpoint(sm, types=["*"])
    await add_endpoint(sm, types=["user.created"])
    _, n, _ = await emit(sm, "order.paid")
    assert n == 2
    _, n, _ = await emit(sm, "invoice.voided")
    assert n == 1


async def test_publish_idempotency_key(sm):
    await add_endpoint(sm)
    a, n1, c1 = await emit(sm, key="order-42-paid")
    b, n2, c2 = await emit(sm, key="order-42-paid")
    assert a == b and c1 and not c2 and n1 == n2 == 1
    async with sm() as s:
        assert await s.scalar(select(func.count()).select_from(Delivery)) == 1


async def test_publish_is_atomic(sm):
    """Event and its deliveries commit together or not at all (outbox pattern)."""
    await add_endpoint(sm)
    from webhooks.services.events import EventCreate, publish
    with pytest.raises(RuntimeError):
        async with sm() as s, s.begin():
            await publish(s, EventCreate(type="order.paid"))
            raise RuntimeError("crash before commit")
    async with sm() as s:
        assert await s.scalar(select(func.count()).select_from(Event)) == 0
        assert await s.scalar(select(func.count()).select_from(Delivery)) == 0


@contextlib.asynccontextmanager
async def api(**cfg):
    app = create_app(make_settings(**cfg))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            yield c


async def test_api_flow(sm):
    async with api() as c:
        assert (await c.get("/endpoints")).status_code == 401
        r = await c.post("/endpoints", json={"url": "http://receiver/webhook", "event_types": ["order.paid"]},
                         headers=AUTH)
        assert r.status_code == 201 and r.json()["secret"].startswith("whsec_")
        eid = r.json()["id"]
        assert "secret" not in (await c.get(f"/endpoints/{eid}", headers=AUTH)).json()
        ev = await c.post("/events", json={"type": "order.paid", "payload": {"x": 1}, "idempotency_key": "k1"},
                          headers=AUTH)
        again = await c.post("/events", json={"type": "order.paid", "payload": {"x": 1}, "idempotency_key": "k1"},
                             headers=AUTH)
        assert ev.status_code == 201 and again.status_code == 200 and ev.json()["deliveries"] == 1
        detail = (await c.get(f"/events/{ev.json()['event']['id']}", headers=AUTH)).json()
        assert detail["deliveries"][0]["status"] == "pending"
        did = detail["deliveries"][0]["id"]
        assert (await c.post(f"/deliveries/{did}/retry", headers=AUTH)).status_code == 409  # still pending
        rot = (await c.post(f"/endpoints/{eid}/rotate-secret", json={"grace_seconds": 60}, headers=AUTH)).json()
        assert rot["secret"].startswith("whsec_") and rot["previous_secret_expires_at"]
        assert (await c.get("/stats", headers=AUTH)).json()["deliveries"] == {"pending": 1}


async def test_api_rejects_unsafe_urls_in_production_mode(sm):
    async with api(allow_private_destinations=False) as c:
        for url in ["http://example.com/hook", "ftp://example.com", "https://u:p@example.com/"]:
            r = await c.post("/endpoints", json={"url": url}, headers=AUTH)
            assert r.status_code == 422, url


async def test_uppercase_event_type_subscription_rejected(sm):
    async with api() as c:
        r = await c.post("/endpoints", json={"url": "http://receiver/webhook", "event_types": ["Order.Paid"]}, headers=AUTH)
        assert r.status_code == 422
