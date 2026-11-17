import os

import pytest
from redis.asyncio import Redis
from sqlalchemy import text

from jobqueue.core.queue import JobQueue
from jobqueue.db.session import make_engine, make_sessionmaker

REDIS_URL = os.getenv("JQ_TEST_REDIS_URL", "redis://127.0.0.1:56379/2")
DB_URL = os.getenv("JQ_TEST_DATABASE_URL",
                   "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p03_job_queue_test")
T0 = 1_700_000_000_000


@pytest.fixture
async def redis():
    r = Redis.from_url(REDIS_URL)
    try:
        await r.ping()
    except Exception:  # pragma: no cover
        pytest.skip("Redis not reachable; start infra/docker-compose.yml")
    await r.flushdb()
    yield r
    await r.flushdb()
    await r.aclose()


@pytest.fixture
async def q(redis):
    return JobQueue(redis, "jqt:", lease_grace_ms=1000)


@pytest.fixture
async def sessionmaker():
    engine = make_engine(DB_URL)
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE processed_jobs, email_outbox RESTART IDENTITY"))
    yield make_sessionmaker(engine)
    await engine.dispose()
