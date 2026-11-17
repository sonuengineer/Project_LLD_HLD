"""The core interview claims, proven by tests:
1. Lua-script limiter is exact under heavy concurrency, even across multiple "app servers".
2. In-memory limiters overshoot when there is more than one server.
3. Shared Redis with a non-atomic GET/SET still overshoots (race condition).
"""
import asyncio

import pytest
from redis.asyncio import Redis

from ratelimiter.domain.models import Algorithm
from ratelimiter.limiter.memory_limiter import InMemoryRateLimiter
from ratelimiter.limiter.naive_redis_limiter import NaiveRedisFixedWindow
from ratelimiter.limiter.redis_limiter import RedisRateLimiter

from .conftest import REDIS_URL, make_policy

T0 = 1_700_000_000_000
LIMIT = 50
REQUESTS = 200

POLICIES = [
    make_policy(Algorithm.FIXED_WINDOW, LIMIT, window=60),
    make_policy(Algorithm.SLIDING_LOG, LIMIT, window=60),
    make_policy(Algorithm.SLIDING_COUNTER, LIMIT, window=60),
    make_policy(Algorithm.TOKEN_BUCKET, LIMIT, rate=0.001),
    make_policy(Algorithm.LEAKY_BUCKET, LIMIT, rate=0.001),
]


@pytest.mark.parametrize("policy", POLICIES, ids=lambda p: p.algorithm.value)
async def test_exact_under_concurrency_across_three_servers(redis, policy):
    # Three independent Redis clients = three app instances with their own connection pools.
    servers = [RedisRateLimiter(Redis.from_url(REDIS_URL)) for _ in range(3)]
    try:
        tasks = [servers[i % 3].check("hot-user", policy, policy.default, now_ms=T0 + 5) for i in range(REQUESTS)]
        results = await asyncio.gather(*tasks)
    finally:
        for s in servers:
            await s._redis.aclose()
    assert sum(r.allowed for r in results) == LIMIT


async def test_in_memory_limiter_overshoots_with_multiple_servers():
    policy = make_policy(Algorithm.FIXED_WINDOW, LIMIT, window=60)
    servers = [InMemoryRateLimiter() for _ in range(3)]  # each server has its own memory
    results = await asyncio.gather(*[servers[i % 3].check("u", policy, policy.default, now_ms=T0)
                                     for i in range(REQUESTS)])
    # Each server allows LIMIT independently -> 3x the intended limit.
    assert sum(r.allowed for r in results) == LIMIT * 3


async def test_naive_get_then_set_on_shared_redis_overshoots(redis):
    policy = make_policy(Algorithm.FIXED_WINDOW, LIMIT, window=60)
    client = Redis.from_url(REDIS_URL, max_connections=REQUESTS)
    lim = NaiveRedisFixedWindow(client)
    results = await asyncio.gather(*[lim.check("u", policy, policy.default, now_ms=T0) for _ in range(REQUESTS)])
    await client.aclose()
    allowed = sum(r.allowed for r in results)
    # Many requests read the same stale count before anyone writes. Exact number varies; it is > LIMIT.
    assert allowed > LIMIT, allowed
