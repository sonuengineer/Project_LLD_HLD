"""The real thing: a worker OS process is hard-killed (TerminateProcess / SIGKILL) after its
handler committed but before it acked. A second worker process must finish the job, and the
side effect must exist exactly once."""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import func, select

from jobqueue.core.models import EnqueueRequest, JobStatus
from jobqueue.db.models import EmailOutbox

from .conftest import DB_URL, REDIS_URL
from .test_worker import wait_status

ROOT = Path(__file__).resolve().parents[1]


def spawn(worker_id: str) -> subprocess.Popen:
    env = {**os.environ, "JQ_REDIS_URL": REDIS_URL, "JQ_DATABASE_URL": DB_URL, "JQ_KEY_PREFIX": "jqt:",
           "JQ_MAX_LEASE_MS": "500", "JQ_LEASE_GRACE_MS": "500", "JQ_REAP_INTERVAL_SECONDS": "0.3",
           "JQ_LOG_LEVEL": "WARNING"}
    return subprocess.Popen([sys.executable, "-m", "jobqueue.worker", "--queues", "default",
                             "--worker-id", worker_id], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def test_kill_minus_nine_worker_process(q, sessionmaker):
    jid, _ = await q.enqueue(EnqueueRequest(type="email.send", timeout_seconds=60, backoff_base_seconds=0.05,
                                            payload={"to": "c@x.io", "crash_after_commit": True}))
    a = spawn("proc-A")
    try:
        async with sessionmaker() as s:
            for _ in range(200):
                if await s.scalar(select(func.count()).select_from(EmailOutbox)):
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError("worker A never committed")
        assert (await q.get(jid)).status == JobStatus.ACTIVE
    finally:
        a.kill()      # hard kill: no cleanup code runs
        a.wait()
    b = spawn("proc-B")
    try:
        job = await wait_status(q, jid, JobStatus.SUCCEEDED, timeout=20)
    finally:
        b.kill()
        b.wait()
    assert job.attempts == 2 and job.worker == "proc-B" and job.result["duplicate"] is True
    async with sessionmaker() as s:
        assert await s.scalar(select(func.count()).select_from(EmailOutbox)) == 1
