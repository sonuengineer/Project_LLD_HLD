import os

import pytest
from redis.asyncio import Redis

from ratelimiter.domain.models import Algorithm, FailMode, Plan, PlanLimit, Policy, Scope

REDIS_URL = os.getenv("RL_TEST_REDIS_URL", "redis://127.0.0.1:56379/15")


@pytest.fixture
async def redis():
    client = Redis.from_url(REDIS_URL)
    try:
        await client.ping()
    except Exception:  # pragma: no cover
        pytest.skip(f"Redis not reachable at {REDIS_URL} (run: docker compose -f infra/docker-compose.yml up -d)")
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.aclose()


def make_policy(algorithm: Algorithm, limit: int, *, window: float | None = None, rate: float | None = None,
                fail_mode: FailMode = FailMode.OPEN, name: str = "test") -> Policy:
    pl = PlanLimit(limit=limit, window_seconds=window, rate_per_second=rate)
    return Policy(name=name, algorithm=algorithm, scope=Scope.IP, fail_mode=fail_mode, plans={}, default=pl)
