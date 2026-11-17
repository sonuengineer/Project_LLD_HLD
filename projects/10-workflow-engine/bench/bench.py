"""(1) end-to-end workflow throughput with 1 vs 2 in-process workers; (2) replay cost vs history length.
    python bench/bench.py"""
import asyncio
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

import flowengine.examples  # noqa: E402,F401
from flowengine import store  # noqa: E402
from flowengine.runtime import replay  # noqa: E402
from flowengine.worker import Worker  # noqa: E402
from tests.conftest import DB_URL  # noqa: E402


async def throughput(sm, workers: int, n: int = 60):
    async with sm() as s, s.begin():
        await s.execute(text("TRUNCATE activity_effects, workers, timers, activity_tasks, history_events, workflows CASCADE"))
    for i in range(n):
        await store.start_workflow(sm, "order_processing", f"b{workers}-{i}",
                                   {"order_id": str(i), "items": [], "amount": 1, "customer": "x@y.z"})
    ws = [Worker(sm, worker_id=f"w{k}", poll_interval=0.01, activity_concurrency=16) for k in range(workers)]
    t0 = time.perf_counter()
    tasks = [asyncio.create_task(w.run()) for w in ws]
    while True:
        async with sm() as s:
            done = await s.scalar(text("SELECT count(*) FROM workflows WHERE status = 'completed'"))
        if done == n:
            break
        await asyncio.sleep(0.05)
    el = time.perf_counter() - t0
    for w in ws:
        w.stop()
    await asyncio.gather(*tasks)
    print(f"{workers} worker(s): {n} order workflows (4 activities each) in {el:.1f}s -> {n / el:.1f} workflows/s, "
          f"{n * 4 / el:.0f} activities/s")


async def throughput_processes(sm, procs: int, n: int = 60):
    """Real deployment shape: N separate worker PROCESSES (python -m flowengine)."""
    import os
    import subprocess
    async with sm() as s, s.begin():
        await s.execute(text("TRUNCATE activity_effects, workers, timers, activity_tasks, history_events, workflows CASCADE"))
    for i in range(n):
        await store.start_workflow(sm, "order_processing", f"p{procs}-{i}",
                                   {"order_id": str(i), "items": [], "amount": 1, "customer": "x@y.z"})
    env = {**os.environ, "FLOW_DATABASE_URL": DB_URL, "FLOW_LOG_LEVEL": "WARNING", "FLOW_POLL_INTERVAL_SECONDS": "0.01"}
    root = Path(__file__).resolve().parents[1]
    t0 = time.perf_counter()
    ps = [subprocess.Popen([sys.executable, "-m", "flowengine", "--activity-concurrency", "16"], cwd=root, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(procs)]
    try:
        while True:
            async with sm() as s:
                done = await s.scalar(text("SELECT count(*) FROM workflows WHERE status = 'completed'"))
            if done == n:
                break
            await asyncio.sleep(0.05)
        el = time.perf_counter() - t0
    finally:
        for p in ps:
            p.kill()
    print(f"{procs} worker PROCESS(es): {n} workflows in {el:.1f}s -> {n / el:.1f} workflows/s (incl. process start-up)")


async def replay_cost():
    async def loop_wf(ctx, inp):
        for i in range(inp["n"]):
            await ctx.execute_activity("notify", "x", str(i))
        return "ok"
    T = datetime.now(timezone.utc)
    for n in (10, 100, 1000):
        hist = [{"event_type": "WorkflowStarted", "attrs": {"input": {"n": n}}, "created_at": T}]
        for i in range(1, n + 1):
            hist += [{"event_type": "ActivityScheduled", "attrs": {"seq": i, "activity_type": "notify"}, "created_at": T},
                     {"event_type": "ActivityCompleted", "attrs": {"seq": i, "result": None}, "created_at": T}]
        t = time.perf_counter()
        r = await replay(loop_wf, "w", "r", hist)
        print(f"replay of {len(hist):>5} events: {(time.perf_counter() - t) * 1000:7.1f} ms ({r.status})")


async def main():
    engine = create_async_engine(DB_URL, pool_size=20, max_overflow=20)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    for w in (1, 2):
        await throughput(sm, w)
    for p in (1, 2, 4):
        await throughput_processes(sm, p)
    await replay_cost()
    await engine.dispose()


asyncio.run(main())
