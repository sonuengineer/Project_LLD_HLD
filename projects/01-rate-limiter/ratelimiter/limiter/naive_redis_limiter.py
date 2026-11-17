"""ANTI-PATTERN, kept for teaching: shared Redis but a non-atomic read-then-write.

    count = GET key        # two concurrent requests both read 4 (limit 5)
    if count < limit:
        SET key count+1    # both write 5 -> both allowed, real count should be 6

Redis being "shared" does not make the logic correct; the check-and-increment must
be one atomic step (Lua script, or INCR-first). tests/test_distributed_correctness.py
shows this implementation overshooting under concurrency.
"""
from __future__ import annotations

import time

from redis.asyncio import Redis

from ..domain.models import Decision, Policy, PlanLimit


class NaiveRedisFixedWindow:
    def __init__(self, redis: Redis):
        self._redis = redis

    async def check(self, key: str, policy: Policy, limit: PlanLimit, *, cost: int = 1,
                    now_ms: int | None = None) -> Decision:
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        window = int(limit.window_seconds * 1000)
        start = now - now % window
        rk = f"naive:{policy.name}:{key}:{start}"
        current = int(await self._redis.get(rk) or 0)          # READ
        if current + cost > limit.limit:
            return Decision(False, limit.limit, 0, window, window, policy.name, policy.algorithm)
        await self._redis.set(rk, current + cost, px=window)    # WRITE (race window between these two awaits)
        return Decision(True, limit.limit, limit.limit - current - cost, 0, window, policy.name, policy.algorithm)
