import os

import pytest
from redis.asyncio import Redis
from sqlalchemy import text

from webhooks.config import Settings
from webhooks.db.session import make_engine, make_sessionmaker
from webhooks.services.ratelimit import EndpointRateLimiter

DB_URL = os.getenv("WH_TEST_DATABASE_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p04_webhooks_test")
REDIS_URL = os.getenv("WH_TEST_REDIS_URL", "redis://127.0.0.1:56379/5")


def make_settings(**kw) -> Settings:
    base = dict(database_url=DB_URL, redis_url=REDIS_URL, api_token="test-token", allow_private_destinations=True,
                retry_schedule_seconds=[0.01, 0.01, 0.01], lease_seconds=30, default_rate_limit_per_second=1000,
                log_json=False, log_level="WARNING")
    base.update(kw)
    return Settings(**base)


@pytest.fixture
async def sm():
    engine = make_engine(DB_URL)
    async with engine.begin() as c:
        await c.execute(text("TRUNCATE delivery_attempts, deliveries, events, endpoints RESTART IDENTITY CASCADE"))
    yield make_sessionmaker(engine)
    await engine.dispose()


@pytest.fixture
async def redis():
    r = Redis.from_url(REDIS_URL)
    await r.flushdb()
    yield r
    await r.flushdb()
    await r.aclose()


@pytest.fixture
async def limiter(redis):
    return EndpointRateLimiter(redis)
