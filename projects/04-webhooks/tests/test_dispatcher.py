import asyncio
from collections import Counter
from datetime import datetime, timezone

import httpx
from sqlalchemy import update

from webhooks.db.models import Delivery
from webhooks.receiver.app import app as receiver_app
from webhooks.services.endpoints import EndpointService

from .helpers import (add_endpoint, attempts, deliveries, dispatcher, drain, emit, endpoint, make_all_due,
                      receiver)


async def test_signed_delivery_verified_by_real_receiver(sm, limiter):
    eid, secret = await add_endpoint(sm)
    ev, n, _ = await emit(sm, payload={"order": 42})
    d = dispatcher(sm, limiter, receiver([secret]))
    assert n == 1 and await d.run_once() == 1
    [row] = await deliveries(sm)
    assert row.status == "succeeded" and row.attempts == 1 and row.last_status_code == 200
    assert receiver_app.state.seen[ev]["data"] == {"order": 42}
    log = await attempts(sm, row.id)
    assert log[0].outcome == "success" and log[0].response_snippet == "ok"
    await d.aclose()


async def test_wrong_secret_is_rejected_by_receiver_and_retried(sm, limiter):
    await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, receiver(["whsec_" + "A" * 44]))
    await drain(sm, d)
    [row] = await deliveries(sm)
    assert row.status == "dead" and row.attempts == 4 and row.last_status_code == 401  # 3 retries + first
    await d.aclose()


async def test_transient_failures_then_success(sm, limiter):
    eid, secret = await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, receiver([secret], fail_next=2))
    await drain(sm, d)
    [row] = await deliveries(sm)
    assert row.status == "succeeded" and row.attempts == 3
    assert [a.outcome for a in await attempts(sm, row.id)] == ["http_error", "http_error", "success"]
    assert (await endpoint(sm, eid)).consecutive_failures == 0   # reset on success
    await d.aclose()


async def test_retry_schedule_with_backoff(sm, limiter):
    await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(500)),
                   retry_schedule_seconds=[60, 600])
    before = datetime.now(timezone.utc)
    await d.run_once()
    [row] = await deliveries(sm)
    gap = (row.next_attempt_at - before).total_seconds()
    assert row.status == "pending" and 48 <= gap <= 73          # 60s +-20% jitter
    assert await d.run_once() == 0                               # not due yet
    await d.aclose()


async def test_410_gone_disables_endpoint(sm, limiter):
    eid, _ = await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(410)))
    await d.run_once()
    [row] = await deliveries(sm)
    ep = await endpoint(sm, eid)
    assert row.status == "dead" and not ep.enabled and "410" in ep.disabled_reason
    await emit(sm)
    assert await d.run_once() == 0   # deliveries for a disabled endpoint wait, they are not claimed
    await d.aclose()


async def test_429_retry_after_is_honoured(sm, limiter):
    await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(429, headers={"retry-after": "120"})))
    before = datetime.now(timezone.utc)
    await d.run_once()
    [row] = await deliveries(sm)
    assert (row.next_attempt_at - before).total_seconds() >= 119   # schedule said 0.01s; receiver said 120s
    await d.aclose()


async def test_timeout_and_connect_errors_are_logged(sm, limiter):
    await add_endpoint(sm)
    await emit(sm)

    def boom(request):
        raise httpx.ReadTimeout("slow", request=request)
    d = dispatcher(sm, limiter, httpx.MockTransport(boom))
    await d.run_once()
    [row] = await deliveries(sm)
    assert (await attempts(sm, row.id))[0].outcome == "timeout" and row.status == "pending"
    await d.aclose()


async def test_ssrf_destination_blocked_at_send_time(sm, limiter):
    await add_endpoint(sm, url="https://127.0.0.1/hook")   # registered while private was allowed (or via DNS rebinding)
    await emit(sm)
    calls = []
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200)),
                   allow_private_destinations=False)
    await d.run_once()
    [row] = await deliveries(sm)
    assert calls == [] and row.status == "dead"
    assert (await attempts(sm, row.id))[0].outcome == "blocked"
    await d.aclose()


async def test_auto_disable_after_consecutive_failures(sm, limiter):
    eid, _ = await add_endpoint(sm)
    for _ in range(3):
        await emit(sm)
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(500)), auto_disable_after_failures=3)
    await d.run_once()
    ep = await endpoint(sm, eid)
    assert not ep.enabled and "3 consecutive" in ep.disabled_reason
    await d.aclose()


async def test_per_endpoint_rate_limit_does_not_burn_attempts(sm, limiter):
    await add_endpoint(sm, rate=2)
    for _ in range(10):
        await emit(sm)
    sent = Counter()
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: sent.update([1]) or httpx.Response(200)))
    await d.run_once()
    rows = await deliveries(sm)
    assert sent[1] == 2                                            # burst = 2 for a 2/s endpoint
    waiting = [r for r in rows if r.status == "pending"]
    assert len(waiting) == 8 and all(r.attempts == 0 for r in waiting)   # rate limiting is not a failure
    assert d.stats["rate_limited"] == 8
    await d.aclose()


async def test_three_dispatchers_deliver_each_exactly_once(sm, limiter):
    eid, secret = await add_endpoint(sm)
    for i in range(150):
        await emit(sm, payload={"i": i})
    seen = Counter()

    def ok(request):
        seen[request.headers["webhook-id"]] += 1
        return httpx.Response(200)
    ds = [dispatcher(sm, limiter, httpx.MockTransport(ok), wid=f"d{i}") for i in range(3)]

    async def loop(d):
        while await d.run_once():
            pass
    await asyncio.gather(*[loop(d) for d in ds])
    assert len(seen) == 150 and set(seen.values()) == {1}
    assert sum(d.stats["succeeded"] for d in ds) == 150
    assert all(d.stats["succeeded"] > 0 for d in ds)               # work was actually shared
    for d in ds:
        await d.aclose()


async def test_crashed_dispatcher_lease_expires_and_zombie_result_is_rejected(sm, limiter):
    eid, secret = await add_endpoint(sm)
    await emit(sm)
    a = dispatcher(sm, limiter, receiver([secret]), wid="A", lease_seconds=0.2)
    [claimed] = await a.claim()                 # A claims ... and "crashes" (never records)
    assert await a.claim() == []
    await asyncio.sleep(0.3)                    # lease expires
    b = dispatcher(sm, limiter, receiver([secret]), wid="B", lease_seconds=30)
    assert await b.run_once() == 1
    [row] = await deliveries(sm)
    assert row.status == "succeeded" and row.attempts == 2
    from webhooks.dispatcher.dispatcher import SendResult
    assert await a._record(claimed, SendResult("http_error", 500, error="late")) == "stale"
    assert (await deliveries(sm))[0].status == "succeeded"
    await a.aclose()
    await b.aclose()


async def test_secret_rotation_without_failed_deliveries(sm, limiter):
    eid, old = await add_endpoint(sm)
    async with sm() as s, s.begin():
        new = (await EndpointService(s, allow_private=True, default_rate=1000).rotate_secret(eid, 3600)).secret
    await emit(sm)
    d = dispatcher(sm, limiter, receiver([old]))     # customer hasn't deployed the new secret yet
    await d.run_once()
    assert (await deliveries(sm))[0].status == "succeeded"
    # grace expired -> only the new secret signs
    async with sm() as s, s.begin():
        from webhooks.db.models import Endpoint
        await s.execute(update(Endpoint).where(Endpoint.id == eid)
                        .values(previous_secret_expires_at=datetime(2000, 1, 1, tzinfo=timezone.utc)))
    await emit(sm)
    d2 = dispatcher(sm, limiter, receiver([old]))
    await d2.run_once()
    assert (await deliveries(sm))[1].last_status_code == 401
    d3 = dispatcher(sm, limiter, receiver([new]))
    await make_all_due(sm)
    await d3.run_once()
    assert (await deliveries(sm))[1].status == "succeeded"
    for x in (d, d2, d3):
        await x.aclose()


async def test_receiver_dedupes_replayed_delivery(sm, limiter):
    eid, secret = await add_endpoint(sm)
    ev, _, _ = await emit(sm)
    t = receiver([secret])
    d = dispatcher(sm, limiter, t)
    await d.run_once()
    async with sm() as s, s.begin():           # operator replays an already-delivered webhook
        await s.execute(update(Delivery).values(status="pending", attempts=0))
    await d.run_once()
    assert receiver_app.state.duplicates == 1 and len(receiver_app.state.seen) == 1
    await d.aclose()


async def test_crashing_delivery_eventually_goes_dead(sm, limiter, monkeypatch):
    """Regression: deliver() raising every time used to keep the row in_flight forever."""
    await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(200)))

    async def boom(c, body):
        raise RuntimeError("bug in serialisation")
    monkeypatch.setattr(d, "_send", boom)
    await drain(sm, d)
    [row] = await deliveries(sm)
    assert row.status == "dead" and row.attempts == 4 and "bug in serialisation" in row.last_error
    await d.aclose()


async def test_claim_backstop_dead_letters_exhausted_expired_rows(sm, limiter):
    await add_endpoint(sm)
    await emit(sm)
    async with sm() as s, s.begin():
        await s.execute(update(Delivery).values(status="in_flight", attempts=4,
                                                locked_until=datetime(2000, 1, 1, tzinfo=timezone.utc)))
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(200)))
    assert await d.run_once() == 0
    [row] = await deliveries(sm)
    assert row.status == "dead" and "final attempt" in row.last_error
    await d.aclose()


async def test_dispatch_loop_survives_database_errors(sm, limiter, monkeypatch):
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(200)))
    calls = {"n": 0}

    async def flaky_run_once():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise ConnectionError("postgres restarting")
        d.stop()
        return 0
    monkeypatch.setattr(d, "run_once", flaky_run_once)
    await asyncio.wait_for(d.run(idle_sleep=0.01), timeout=5)   # used to raise out of run()
    assert calls["n"] == 3
    await d.aclose()


async def test_retry_after_is_capped(sm, limiter):
    await add_endpoint(sm)
    await emit(sm)
    d = dispatcher(sm, limiter, httpx.MockTransport(lambda r: httpx.Response(503, headers={"retry-after": "99999999"})))
    before = datetime.now(timezone.utc)
    await d.run_once()
    [row] = await deliveries(sm)
    assert (row.next_attempt_at - before).total_seconds() <= 24 * 3600 + 5
    await d.aclose()


async def test_connection_is_pinned_to_the_validated_ip(sm, limiter, monkeypatch):
    """DNS-rebinding TOCTOU: the request must go to the IP that passed the SSRF check."""
    from webhooks.dispatcher import dispatcher as dmod
    await add_endpoint(sm, url="https://hooks.example.com/x")
    await emit(sm)
    seen = []

    async def fake_check(url, allow_private):
        return "93.184.215.14"
    monkeypatch.setattr(dmod, "assert_public_destination", fake_check)

    def capture(request):
        seen.append((request.url.host, request.headers["host"], request.extensions.get("sni_hostname")))
        return httpx.Response(200)
    d = dispatcher(sm, limiter, httpx.MockTransport(capture), allow_private_destinations=False)
    await d.run_once()
    assert seen == [("93.184.215.14", "hooks.example.com", "hooks.example.com")]
    await d.aclose()
