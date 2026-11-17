"""Real workers (in-process) running real handlers against Redis + Postgres."""
import asyncio

from sqlalchemy import func, select

from jobqueue.core.models import EnqueueRequest, JobStatus
from jobqueue.db.models import EmailOutbox
from jobqueue.handlers.builtin import registry
from jobqueue.worker.worker import Worker


def make_worker(q, sm, **kw):
    kw.setdefault("concurrency", 4)
    kw.setdefault("reap_interval", 0.2)
    kw.setdefault("heartbeat_interval", 0.2)
    return Worker(q, registry, ["critical", "default"], sessionmaker=sm, **kw)


async def wait_status(q, job_id, status, timeout=10.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        job = await q.get(job_id)
        if job and job.status == status:
            return job
        await asyncio.sleep(0.05)
    raise AssertionError(f"job {job_id} never reached {status}; last={job and job.status}")


async def run_worker(w):
    return asyncio.create_task(w.run())


async def test_end_to_end_success_retry_poison_timeout(q, sessionmaker):
    w = make_worker(q, sessionmaker)
    task = await run_worker(w)
    try:
        email, _ = await q.enqueue(EnqueueRequest(type="email.send", payload={"to": "a@x.io", "subject": "hi"}))
        flaky, _ = await q.enqueue(EnqueueRequest(type="demo.flaky", payload={"succeed_on_attempt": 3},
                                                  backoff_base_seconds=0.05))
        poison, _ = await q.enqueue(EnqueueRequest(type="demo.poison", max_attempts=3, backoff_base_seconds=0.05))
        slow, _ = await q.enqueue(EnqueueRequest(type="demo.sleep", payload={"seconds": 5}, timeout_seconds=0.2,
                                                 max_attempts=2, backoff_base_seconds=0.05))
        unknown, _ = await q.enqueue(EnqueueRequest(type="nope.missing", max_attempts=5))
        assert (await wait_status(q, email, JobStatus.SUCCEEDED)).result["duplicate"] is False
        assert (await wait_status(q, flaky, JobStatus.SUCCEEDED)).result == {"succeeded_on_attempt": 3}
        p = await wait_status(q, poison, JobStatus.DEAD)
        assert p.attempts == 3 and "cannot process" in p.last_error
        s = await wait_status(q, slow, JobStatus.DEAD)
        assert s.last_failure_reason == "timeout" and s.attempts == 2
        u = await wait_status(q, unknown, JobStatus.DEAD)
        assert u.attempts == 1 and u.last_failure_reason == "permanent"
    finally:
        w.stop()
        await task
    async with sessionmaker() as s:
        assert await s.scalar(select(func.count()).select_from(EmailOutbox)) == 1


async def test_queue_priority_across_queues(q, sessionmaker):
    """Worker lists ['critical', 'default']: critical jobs drain first."""
    defaults = [(await q.enqueue(EnqueueRequest(type="report.generate", queue="default",
                                                payload={"seconds": 0})))[0] for _ in range(5)]
    crit, _ = await q.enqueue(EnqueueRequest(type="report.generate", queue="critical", payload={"seconds": 0}))
    w = make_worker(q, sessionmaker, concurrency=1)
    task = await run_worker(w)
    try:
        c = await wait_status(q, crit, JobStatus.SUCCEEDED)
        ds = [await wait_status(q, d, JobStatus.SUCCEEDED) for d in defaults]
        # enqueued LAST but started FIRST
        assert all(c.started_at < d.started_at for d in ds)
    finally:
        w.stop()
        await task


async def test_redelivery_after_crash_is_idempotent(q, sessionmaker):
    """Worker A commits the email then 'dies' before acking (we cancel it hard, no ack).
    Lease expires -> worker B gets attempt 2 -> handler sees processed_jobs row -> no 2nd email."""
    jid, _ = await q.enqueue(EnqueueRequest(type="email.send", timeout_seconds=30, backoff_base_seconds=0.05,
                                            payload={"to": "b@x.io", "crash_after_commit": True}))
    a = make_worker(q, sessionmaker, worker_id="A", max_lease_ms=300)
    ta = await run_worker(a)
    async with sessionmaker() as s:
        for _ in range(100):
            if await s.scalar(select(func.count()).select_from(EmailOutbox)):
                break
            await asyncio.sleep(0.05)
    ta.cancel()      # crash: no ack, no fail, heartbeats and lease extensions stop
    for t in list(a.running.values()):
        t.cancel()
    await asyncio.gather(ta, *a.running.values(), return_exceptions=True)
    b = make_worker(q, sessionmaker, worker_id="B", max_lease_ms=300)
    tb = await run_worker(b)
    try:
        job = await wait_status(q, jid, JobStatus.SUCCEEDED, timeout=15)
    finally:
        b.stop()
        await tb
    assert job.attempts == 2 and job.result["duplicate"] is True
    assert job.errors[0]["reason"] == "lease_expired"
    async with sessionmaker() as s:
        assert await s.scalar(select(func.count()).select_from(EmailOutbox)) == 1


async def test_heartbeat_and_graceful_shutdown(q, sessionmaker):
    w = make_worker(q, sessionmaker, worker_id="hb-1", shutdown_grace=5)
    task = await run_worker(w)
    jid, _ = await q.enqueue(EnqueueRequest(type="demo.sleep", payload={"seconds": 0.5}))
    for _ in range(50):
        if jid in w.running:
            break
        await asyncio.sleep(0.02)
    assert await q.r.exists(f"{q.p}worker:hb-1:alive")
    w.stop()          # in-flight job must finish, not be abandoned
    await task
    assert (await q.get(jid)).status == JobStatus.SUCCEEDED
    assert not await q.r.hexists(f"{q.p}workers", "hb-1")


async def test_lease_keeper_survives_transient_redis_errors(q, sessionmaker, monkeypatch):
    """Regression: one failed extend_lease call used to end lease keeping for the whole job."""
    real = q.extend_lease
    calls = {"n": 0}

    async def flaky_extend(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("redis blip")
        return await real(*a, **k)
    monkeypatch.setattr(q, "extend_lease", flaky_extend)
    w = make_worker(q, sessionmaker, max_lease_ms=300)   # lease ~1.3s, extended every ~0.43s
    task = await run_worker(w)
    try:
        jid, _ = await q.enqueue(EnqueueRequest(type="demo.sleep", payload={"seconds": 2.5}, timeout_seconds=10))
        job = await wait_status(q, jid, JobStatus.SUCCEEDED, timeout=10)
    finally:
        w.stop()
        await task
    assert job.attempts == 1 and calls["n"] >= 3     # never reaped, kept extending after the blip
