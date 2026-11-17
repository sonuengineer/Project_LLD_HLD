"""Algorithm semantics with a controlled clock (now_ms is injected, so tests are deterministic)."""
from ratelimiter.domain.models import Algorithm
from ratelimiter.limiter.redis_limiter import RedisRateLimiter

from .conftest import make_policy

T0 = 1_700_000_000_000  # aligned to a 1s boundary (divisible by 1000)


async def run(lim, policy, now, key="u1", cost=1):
    return await lim.check(key, policy, policy.default, cost=cost, now_ms=now)


class TestFixedWindow:
    async def test_allows_limit_then_denies_until_window_end(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.FIXED_WINDOW, 3, window=1)
        results = [await run(lim, p, T0 + 100) for _ in range(4)]
        assert [r.allowed for r in results] == [True, True, True, False]
        assert [r.remaining for r in results[:3]] == [2, 1, 0]
        assert results[3].retry_after_ms == 900  # window ends at T0+1000
        assert (await run(lim, p, T0 + 1000)).allowed  # new window

    async def test_denied_requests_are_not_counted(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.FIXED_WINDOW, 1, window=1)
        assert (await run(lim, p, T0)).allowed
        for _ in range(5):
            assert not (await run(lim, p, T0 + 1)).allowed
        assert int(await redis.get(f"rl:test:{{u1}}:{T0}")) == 1

    async def test_boundary_burst_weakness(self, redis):
        """Known weakness: limit 3/s, yet 6 requests pass within 2ms across the boundary."""
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.FIXED_WINDOW, 3, window=1)
        late = [await run(lim, p, T0 + 999) for _ in range(3)]
        early = [await run(lim, p, T0 + 1000) for _ in range(3)]
        assert all(r.allowed for r in late + early)


class TestSlidingLog:
    async def test_exact_window_and_retry_after(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.SLIDING_LOG, 3, window=1)
        for t in (0, 100, 200):
            assert (await run(lim, p, T0 + t)).allowed
        denied = await run(lim, p, T0 + 300)
        assert not denied.allowed
        assert denied.retry_after_ms == 700  # oldest (t=0) leaves at t=1000
        assert not (await run(lim, p, T0 + 999)).allowed
        assert (await run(lim, p, T0 + 1001)).allowed

    async def test_no_boundary_burst(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.SLIDING_LOG, 3, window=1)
        late = [await run(lim, p, T0 + 999) for _ in range(3)]
        early = [await run(lim, p, T0 + 1000) for _ in range(3)]
        assert all(r.allowed for r in late)
        assert not any(r.allowed for r in early)


class TestSlidingCounter:
    async def test_weights_previous_window(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.SLIDING_COUNTER, 10, window=1)
        for _ in range(10):
            assert (await run(lim, p, T0 + 500)).allowed
        # 25% into next window: estimate = 0 + 10 * 0.75 = 7.5 -> 2 more fit (8.5, 9.5), 3rd would be 10.5
        allowed = [(await run(lim, p, T0 + 1250)).allowed for _ in range(3)]
        assert allowed == [True, True, False]

    async def test_previous_window_fully_expires(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.SLIDING_COUNTER, 2, window=1)
        assert (await run(lim, p, T0)).allowed and (await run(lim, p, T0)).allowed
        assert (await run(lim, p, T0 + 2000)).allowed  # two windows later, prev window is empty


class TestTokenBucket:
    async def test_burst_then_refill(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.TOKEN_BUCKET, 5, rate=1)
        burst = [await run(lim, p, T0) for _ in range(6)]
        assert [r.allowed for r in burst] == [True] * 5 + [False]
        assert burst[5].retry_after_ms == 1000
        after = [await run(lim, p, T0 + 2000) for _ in range(3)]  # 2 tokens refilled
        assert [r.allowed for r in after] == [True, True, False]

    async def test_fractional_refill_is_preserved(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.TOKEN_BUCKET, 1, rate=1)
        assert (await run(lim, p, T0)).allowed
        assert not (await run(lim, p, T0 + 500)).allowed   # 0.5 tokens
        assert (await run(lim, p, T0 + 1000)).allowed       # 0.5 + 0.5 = 1, not lost to rounding

    async def test_cost_greater_than_one(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.TOKEN_BUCKET, 10, rate=1)
        assert (await run(lim, p, T0, cost=7)).allowed
        d = await run(lim, p, T0, cost=7)
        assert not d.allowed and d.remaining == 3 and d.retry_after_ms == 4000


class TestLeakyBucket:
    async def test_smooth_rate(self, redis):
        lim, p = RedisRateLimiter(redis), make_policy(Algorithm.LEAKY_BUCKET, 3, rate=1)
        r = [await run(lim, p, T0) for _ in range(4)]
        assert [x.allowed for x in r] == [True, True, True, False]
        assert r[3].retry_after_ms == 1000
        assert (await run(lim, p, T0 + 1000)).allowed       # one unit leaked
        assert not (await run(lim, p, T0 + 1000)).allowed


async def test_uses_redis_server_time_when_now_not_given(redis):
    lim, p = RedisRateLimiter(redis), make_policy(Algorithm.FIXED_WINDOW, 2, window=60)
    r = [await lim.check("k", p, p.default) for _ in range(3)]
    assert [x.allowed for x in r] == [True, True, False]


async def test_survives_script_cache_flush(redis):
    """After a Redis restart the script cache is empty; EVALSHA gets NOSCRIPT and redis-py re-sends."""
    lim, p = RedisRateLimiter(redis), make_policy(Algorithm.TOKEN_BUCKET, 2, rate=1)
    assert (await run(lim, p, T0)).allowed
    await redis.script_flush()
    assert (await run(lim, p, T0)).allowed


async def test_keys_expire(redis):
    lim, p = RedisRateLimiter(redis), make_policy(Algorithm.TOKEN_BUCKET, 2, rate=1)
    await run(lim, p, T0)
    ttl = await redis.pttl("rl:test:{u1}")
    assert 0 < ttl <= 3000
