import contextlib

import httpx

from jobqueue.config import Settings
from jobqueue.main import create_app

from .conftest import REDIS_URL

AUTH = {"Authorization": "Bearer test-token"}


@contextlib.asynccontextmanager
async def client(redis):
    app = create_app(Settings(redis_url=REDIS_URL, api_token="test-token", key_prefix="jqt:",
                              log_json=False, log_level="WARNING"), redis=redis)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            yield c


async def test_auth_required(redis):
    async with client(redis) as c:
        assert (await c.get("/queues")).status_code == 401
        assert (await c.get("/queues", headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await c.get("/healthz")).status_code == 200


async def test_enqueue_get_list_cancel(redis):
    async with client(redis) as c:
        r = await c.post("/jobs", json={"type": "email.send", "payload": {"to": "a@b.c"}, "priority": 7},
                         headers=AUTH)
        assert r.status_code == 201 and r.json()["created"] is True
        jid = r.json()["job"]["id"]
        assert (await c.get(f"/jobs/{jid}", headers=AUTH)).json()["status"] == "queued"
        listed = (await c.get("/jobs?queue=default&status=queued", headers=AUTH)).json()["jobs"]
        assert [j["id"] for j in listed] == [jid]
        assert (await c.delete(f"/jobs/{jid}", headers=AUTH)).json() == {"cancelled": True}
        assert (await c.delete(f"/jobs/{jid}", headers=AUTH)).status_code == 409
        assert (await c.get("/jobs/nope", headers=AUTH)).status_code == 404


async def test_idempotent_enqueue_returns_200_and_same_job(redis):
    async with client(redis) as c:
        body = {"type": "email.send", "payload": {"to": "a@b.c"}, "idempotency_key": "signup-123"}
        a = await c.post("/jobs", json=body, headers=AUTH)
        b = await c.post("/jobs", json=body, headers=AUTH)
    assert a.status_code == 201 and b.status_code == 200
    assert a.json()["job"]["id"] == b.json()["job"]["id"]


async def test_validation_errors(redis):
    async with client(redis) as c:
        r = await c.post("/jobs", json={"type": "x", "priority": 99}, headers=AUTH)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


async def test_dlq_requeue_flow(redis):
    async with client(redis) as c:
        jid = (await c.post("/jobs", json={"type": "demo.poison", "max_attempts": 1}, headers=AUTH)).json()["job"]["id"]
        q = c._transport.app.state.queue
        job, token = await q.claim("default", "w")
        assert await q.fail(job, token, "boom") == "dead"
        dlq = (await c.get("/dlq?queue=default", headers=AUTH)).json()["jobs"]
        assert [j["id"] for j in dlq] == [jid]
        assert (await c.post(f"/dlq/{jid}/requeue", headers=AUTH)).json() == {"requeued": True}
        assert (await c.post(f"/dlq/{jid}/requeue", headers=AUTH)).status_code == 409
        stats = (await c.get("/queues", headers=AUTH)).json()["queues"][0]
        assert stats["ready"] == 1 and stats["dead"] == 0 and stats["counters"]["requeued_from_dlq"] == 1


async def test_schedules_crud(redis):
    async with client(redis) as c:
        body = {"name": "cleanup", "interval_seconds": 60, "job": {"type": "report.generate"}}
        assert (await c.post("/schedules", json=body, headers=AUTH)).status_code == 201
        assert [s["name"] for s in (await c.get("/schedules", headers=AUTH)).json()["schedules"]] == ["cleanup"]
        assert (await c.delete("/schedules/cleanup", headers=AUTH)).status_code == 200
        assert (await c.delete("/schedules/cleanup", headers=AUTH)).status_code == 404


async def test_workers_endpoint_reports_stale(redis):
    import json
    import time
    await redis.hset("jqt:workers", "ghost", json.dumps({"id": "ghost", "queues": ["default"], "running": [],
                                                          "processed": 1, "succeeded": 1, "failed": 0,
                                                          "stale_acks": 0, "last_heartbeat": time.time() - 60}))
    async with client(redis) as c:
        w = (await c.get("/workers", headers=AUTH)).json()["workers"][0]
    assert w["alive"] is False and w["seconds_since_heartbeat"] >= 59
