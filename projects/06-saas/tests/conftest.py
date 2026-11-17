import os

import pytest
from redis.asyncio import Redis
from sqlalchemy import text

from saas.db.session import make_engine, make_sessionmaker

APP_URL = os.getenv("SAAS_TEST_DATABASE_URL", "postgresql+asyncpg://saas_app:saas_app_dev@127.0.0.1:55432/p06_saas_test")
OWNER_URL = os.getenv("SAAS_TEST_OWNER_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p06_saas_test")
REDIS_URL = os.getenv("SAAS_TEST_REDIS_URL", "redis://127.0.0.1:56379/7")
TABLES = ("refresh_tokens, billing_events, reports, subscriptions, usage_counters, audit_logs, api_keys, "
          "projects, invitations, memberships, tenants, users")


@pytest.fixture
async def clean_db():
    owner = make_engine(OWNER_URL)
    async with owner.begin() as c:
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    await owner.dispose()


@pytest.fixture
async def sm(clean_db):
    engine = make_engine(APP_URL)
    yield make_sessionmaker(engine)
    await engine.dispose()


@pytest.fixture
async def redis():
    r = Redis.from_url(REDIS_URL)
    await r.flushdb()
    yield r
    await r.flushdb()
    await r.aclose()
