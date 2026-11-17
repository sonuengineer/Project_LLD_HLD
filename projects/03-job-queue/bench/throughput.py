"""End-to-end throughput: enqueue N no-op jobs, run W worker processes, time until all succeed.

    python bench/throughput.py --jobs 5000 --workers 4 --concurrency 16
Uses the real worker CLI as subprocesses (separate OS processes, like production).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

from redis.asyncio import BlockingConnectionPool, Redis

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobqueue.core.models import EnqueueRequest  # noqa: E402
from jobqueue.core.queue import JobQueue  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=5000)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--concurrency", type=int, default=16)
    ap.add_argument("--redis", default="redis://127.0.0.1:56379/3")
    a = ap.parse_args()
    r = Redis(connection_pool=BlockingConnectionPool.from_url(a.redis, max_connections=50, timeout=10))
    await r.flushdb()
    q = JobQueue(r, "jqb:")
    t0 = time.perf_counter()
    pipe_batch = 200
    for start in range(0, a.jobs, pipe_batch):
        await asyncio.gather(*[q.enqueue(EnqueueRequest(type="report.generate", payload={"seconds": 0}))
                               for _ in range(min(pipe_batch, a.jobs - start))])
    enq = time.perf_counter() - t0
    print(f"enqueued {a.jobs} jobs in {enq:.2f}s -> {a.jobs / enq:.0f} enqueue/s")
    env = {**os.environ, "JQ_REDIS_URL": a.redis, "JQ_KEY_PREFIX": "jqb:", "JQ_LOG_LEVEL": "WARNING"}
    t1 = time.perf_counter()
    procs = [subprocess.Popen([sys.executable, "-m", "jobqueue.worker", "--queues", "default",
                               "--concurrency", str(a.concurrency)], cwd=ROOT, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(a.workers)]
    try:
        while True:
            done = int((await r.hget("jqb:q:default:stats", "succeeded")) or 0)
            if done >= a.jobs:
                break
            await asyncio.sleep(0.1)
        el = time.perf_counter() - t1
        print(f"processed {a.jobs} jobs with {a.workers} worker processes x {a.concurrency} slots in "
              f"{el:.2f}s -> {a.jobs / el:.0f} jobs/s (includes worker process start-up)")
    finally:
        for p in procs:
            p.kill()
        await r.flushdb()
        await r.aclose()


if __name__ == "__main__":
    asyncio.run(main())
