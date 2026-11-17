"""Queue mechanics with an injected clock (deterministic)."""
import asyncio
import random

import pytest

from jobqueue.core.backoff import retry_delay_ms
from jobqueue.core.models import EnqueueRequest, JobStatus, ScheduleRequest

from .conftest import T0


def req(**kw) -> EnqueueRequest:
    kw.setdefault("type", "demo.sleep")
    return EnqueueRequest(**kw)


async def test_priority_then_fifo(q):
    ids = {}
    for name, pri in [("low1", 1), ("high1", 9), ("mid", 5), ("high2", 9), ("low2", 1)]:
        ids[name], _ = await q.enqueue(req(priority=pri, payload={"n": name}), now_ms=T0)
    order = []
    while (c := await q.claim("default", "w", now_ms=T0)):
        order.append(c[0].payload["n"])
    assert order == ["high1", "high2", "mid", "low1", "low2"]


async def test_delayed_and_scheduled_jobs(q):
    a, _ = await q.enqueue(req(delay_seconds=10), now_ms=T0)
    b, _ = await q.enqueue(req(run_at_ms=T0 + 5000), now_ms=T0)
    assert (await q.get(a)).status == JobStatus.DELAYED
    assert await q.claim("default", "w", now_ms=T0 + 4999) is None
    job, _ = await q.claim("default", "w", now_ms=T0 + 5000)
    assert job.id == b
    job, _ = await q.claim("default", "w", now_ms=T0 + 10_000)
    assert job.id == a


async def test_enqueue_idempotency_key(q):
    a, created_a = await q.enqueue(req(idempotency_key="order-42"), now_ms=T0)
    b, created_b = await q.enqueue(req(idempotency_key="order-42"), now_ms=T0)
    assert a == b and created_a and not created_b
    assert (await q.queue_stats("default"))["ready"] == 1


async def test_ack_success(q):
    jid, _ = await q.enqueue(req(), now_ms=T0)
    job, token = await q.claim("default", "w1", now_ms=T0)
    assert token == 1 and job.status == JobStatus.ACTIVE and job.worker == "w1"
    assert await q.ack(job, token, {"ok": 1}, now_ms=T0 + 10)
    done = await q.get(jid)
    assert done.status == JobStatus.SUCCEEDED and done.result == {"ok": 1}
    assert 0 < await q.r.ttl(q.job_key(jid)) <= q.retention_s   # finished jobs expire (retention)
    assert (await q.queue_stats("default"))["active"] == 0


async def test_retry_with_backoff_then_dead_letter(q):
    jid, _ = await q.enqueue(req(max_attempts=3), now_ms=T0)
    now = T0
    outcomes = []
    for attempt in (1, 2, 3):
        job, token = await q.claim("default", "w", now_ms=now)
        assert token == attempt
        outcomes.append(await q.fail(job, token, "boom", now_ms=now, delay_ms=1000))
        if outcomes[-1] == "retry":
            assert await q.claim("default", "w", now_ms=now + 999) is None   # still backing off
            now += 1000
    assert outcomes == ["retry", "retry", "dead"]
    job = await q.get(jid)
    assert job.status == JobStatus.DEAD and len(job.errors) == 3
    assert (await q.queue_stats("default"))["dead"] == 1
    # replay from the DLQ after "fixing the bug"
    assert await q.requeue_dead("default", jid)
    job, token = await q.claim("default", "w", now_ms=now)
    assert token == 1 and job.id == jid


async def test_permanent_error_skips_remaining_attempts(q):
    jid, _ = await q.enqueue(req(max_attempts=10), now_ms=T0)
    job, token = await q.claim("default", "w", now_ms=T0)
    assert await q.fail(job, token, "bad payload", permanent=True, now_ms=T0) == "dead"


async def test_visibility_timeout_reaper_and_fencing(q):
    """Worker A claims, stalls past its lease. Reaper re-queues, worker B claims (attempt 2).
    When A wakes up its ack/fail must be REJECTED (stale fencing token)."""
    jid, _ = await q.enqueue(req(timeout_seconds=10), now_ms=T0)
    job_a, token_a = await q.claim("default", "A", now_ms=T0)
    lease = job_a.lease_until - T0
    assert lease == 10_000 + 1000  # min(timeout, max_lease) + grace
    assert await q.reap_expired("default", now_ms=T0 + lease - 1) == {"retry": 0, "dead": 0, "stale": 0}
    out = await q.reap_expired("default", now_ms=T0 + lease + 1)
    assert out["retry"] == 1
    job_b, token_b = await q.claim("default", "B", now_ms=T0 + lease + 10_000)
    assert token_b == 2 and job_b.id == jid
    assert await q.ack(job_a, token_a, "late", now_ms=T0 + lease + 10_001) is False    # zombie rejected
    assert await q.fail(job_a, token_a, "late", now_ms=T0 + lease + 10_001) == "stale"
    assert await q.extend_lease(job_a, token_a, 5000, now_ms=T0 + lease + 10_001) is False
    assert await q.ack(job_b, token_b, "ok", now_ms=T0 + lease + 10_002) is True
    assert (await q.get(jid)).errors[0]["reason"] == "lease_expired"


async def test_extended_lease_is_not_reaped(q):
    await q.enqueue(req(timeout_seconds=3600), now_ms=T0)
    job, token = await q.claim("default", "w", now_ms=T0, max_lease_ms=30_000)
    assert job.lease_until == T0 + 31_000      # capped lease, not 1h
    assert await q.extend_lease(job, token, 31_000, now_ms=T0 + 20_000)
    out = await q.reap_expired("default", now_ms=T0 + 40_000)
    assert out == {"retry": 0, "dead": 0, "stale": 0}


async def test_cancel_only_before_start(q):
    a, _ = await q.enqueue(req(), now_ms=T0)
    job = await q.get(a)
    assert await q.cancel(job)
    assert (await q.get(a)).status == JobStatus.CANCELLED
    b, _ = await q.enqueue(req(), now_ms=T0)
    claimed, _ = await q.claim("default", "w", now_ms=T0)
    assert await q.cancel(claimed) is False


async def test_concurrent_claimers_get_each_job_exactly_once(q):
    for i in range(1000):
        await q.enqueue(req(payload={"i": i}), now_ms=T0)
    seen: list[str] = []

    async def claimer(name):
        while (c := await q.claim("default", name, now_ms=T0)):
            seen.append(c[0].id)

    await asyncio.gather(*[claimer(f"w{i}") for i in range(20)])
    assert len(seen) == 1000 and len(set(seen)) == 1000


async def test_schedule_fires_once_even_with_many_schedulers(q):
    await q.put_schedule(ScheduleRequest(name="nightly", interval_seconds=60,
                                         job=req(type="report.generate")), now_ms=T0)
    results = await asyncio.gather(*[q.tick_schedules(now_ms=T0) for _ in range(5)])
    assert sum(len(r) for r in results) == 1
    assert sum(len(r) for r in await asyncio.gather(*[q.tick_schedules(now_ms=T0 + 30_000) for _ in range(5)])) == 0
    # downtime of 10 intervals: fire ONCE, then next_run is aligned to the future (no burst)
    fired = await q.tick_schedules(now_ms=T0 + 600_000)
    assert len(fired) == 1
    s = (await q.list_schedules())[0]
    assert s["next_run_ms"] > T0 + 600_000


def test_backoff_is_bounded_and_jittered():
    rng = random.Random(42)
    delays = [retry_delay_ms(5, base_ms=1000, max_ms=10_000, rng=rng) for _ in range(500)]
    assert all(0 <= d <= 10_000 for d in delays)   # 1000 * 2^4 = 16000 capped at 10000
    assert len(set(delays)) > 400                    # spread out, not one synchronized retry time
    assert max(retry_delay_ms(1, 1000, 10_000, rng) for _ in range(100)) <= 1000


async def test_validation():
    with pytest.raises(ValueError):
        EnqueueRequest(type="x", delay_seconds=1, run_at_ms=1)
    with pytest.raises(ValueError):
        EnqueueRequest(type="BAD TYPE")
    with pytest.raises(ValueError):
        EnqueueRequest(type="x", priority=10)


async def test_claim_many_returns_best_jobs_in_one_call(q):
    for i in range(10):
        await q.enqueue(req(priority=i % 3, payload={"i": i}), now_ms=T0)
    got = await q.claim_many("default", "w", 4, now_ms=T0)
    assert len(got) == 4 and all(job.priority == 2 for job, _ in got[:3])
    assert [job.payload["i"] for job, _ in got[:3]] == [2, 5, 8]   # priority, then FIFO
    assert all(token == 1 and job.status == "active" for job, token in got)
    assert (await q.queue_stats("default"))["active"] == 4


async def test_corrupt_job_field_does_not_lose_the_job(q):
    """Regression: claim.lua raised after ZPOPMIN on a corrupt timeout -> job vanished from the queue.
    Now: the script uses defaults, and the unparseable record goes to the DLQ with a clear error
    instead of crashing the worker's claim loop."""
    jid, _ = await q.enqueue(req(), now_ms=T0)
    good, _ = await q.enqueue(req(), now_ms=T0)
    await q.r.hset(q.job_key(jid), "timeout_ms", "not-a-number")
    got = await q.claim_many("default", "w", 5, now_ms=T0)
    assert [j.id for j, _ in got] == [good]                 # the healthy job is still served
    dead = await q.r.hget(q.job_key(jid), "status")
    assert dead == b"dead"
    assert b"corrupt job record" in await q.r.hget(q.job_key(jid), "last_error")


async def test_schedule_catch_up_is_constant_time(q):
    await q.put_schedule(ScheduleRequest(name="tiny", interval_seconds=1, job=req()), now_ms=T0)
    fired = await q.tick_schedules(now_ms=T0 + 10 * 365 * 24 * 3600 * 1000)   # 10 years of 1s intervals
    assert len(fired) == 1
    s = (await q.list_schedules())[0]
    assert T0 + 10 * 365 * 24 * 3600 * 1000 < s["next_run_ms"] <= T0 + 10 * 365 * 24 * 3600 * 1000 + 1000


async def test_finished_and_cancelled_jobs_expire(q):
    a, _ = await q.enqueue(req(max_attempts=2), now_ms=T0)
    job, token = await q.claim("default", "w", now_ms=T0)
    await q.fail(job, token, "x", now_ms=T0, delay_ms=0)
    job, token = await q.claim("default", "w", now_ms=T0)
    await q.ack(job, token, None, now_ms=T0)
    assert 0 < await q.r.ttl(q.job_key(a) + ":errors") <= q.retention_s
    b, _ = await q.enqueue(req(), now_ms=T0)
    await q.cancel(await q.get(b))
    assert 0 < await q.r.ttl(q.job_key(b)) <= q.retention_s
