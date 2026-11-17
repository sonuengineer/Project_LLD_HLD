import asyncio
import contextlib
import os

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import flowengine.examples  # noqa: F401
from flowengine.worker import Worker

DB_URL = os.getenv("FLOW_TEST_DATABASE_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p10_workflows_test")


@pytest.fixture
async def sm():
    engine = create_async_engine(DB_URL, pool_size=10, max_overflow=20)
    async with engine.begin() as c:
        await c.execute(text("TRUNCATE activity_effects, workers, timers, activity_tasks, history_events, workflows CASCADE"))
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@contextlib.asynccontextmanager
async def worker(sm, crash: bool = False, **kw):
    kw.setdefault("poll_interval", 0.02)
    w = Worker(sm, **kw)
    t = asyncio.create_task(w.run())
    try:
        yield w
    finally:
        w.kill() if crash else w.stop()
        await t


async def wait_status(sm, workflow_id, status="completed", timeout=15.0):
    from flowengine import store
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        d = await store.describe(sm, workflow_id)
        if d["status"] == status:
            return d
        await asyncio.sleep(0.03)
    raise AssertionError(f"{workflow_id} stuck in {d['status']} (error={d.get('error')})")


async def effects(sm, kind=None):
    async with sm() as s:
        q = "SELECT kind, count(*) FROM activity_effects"
        if kind:
            q += f" WHERE kind = '{kind}'"
        return dict((await s.execute(text(q + " GROUP BY kind"))).all())
