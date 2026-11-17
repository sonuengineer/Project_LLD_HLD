"""In-process limiter. Correct for ONE process, wrong for a fleet.

Kept on purpose as a teaching contrast: run two instances (two "servers") and each
allows the full limit, so the user gets N x limit. See tests/test_distributed_correctness.py.
"""
from __future__ import annotations

import asyncio
import time

from ..domain.models import Algorithm, Decision, Policy, PlanLimit


class InMemoryRateLimiter:
    def __init__(self) -> None:
        self._counters: dict[str, int] = {}
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = asyncio.Lock()  # protects against interleaving inside ONE event loop only

    async def check(self, key: str, policy: Policy, limit: PlanLimit, *, cost: int = 1,
                    now_ms: int | None = None) -> Decision:
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        async with self._lock:
            if policy.algorithm is Algorithm.TOKEN_BUCKET:
                return self._token_bucket(key, policy, limit, cost, now)
            if policy.algorithm is Algorithm.FIXED_WINDOW:
                return self._fixed_window(key, policy, limit, cost, now)
        raise NotImplementedError(f"in-memory demo supports fixed_window/token_bucket, not {policy.algorithm}")

    def _fixed_window(self, key, policy, limit, cost, now) -> Decision:
        window = int(limit.window_seconds * 1000)
        start = now - now % window
        ck = f"{policy.name}:{key}:{start}"
        current = self._counters.get(ck, 0)
        reset = start + window - now
        if current + cost > limit.limit:
            return Decision(False, limit.limit, max(limit.limit - current, 0), reset, reset, policy.name, policy.algorithm)
        self._counters[ck] = current + cost
        return Decision(True, limit.limit, limit.limit - current - cost, 0, reset, policy.name, policy.algorithm)

    def _token_bucket(self, key, policy, limit, cost, now) -> Decision:
        bk = f"{policy.name}:{key}"
        tokens, ts = self._buckets.get(bk, (float(limit.limit), now))
        tokens = min(limit.limit, tokens + (now - ts) * limit.rate_per_second / 1000)
        if tokens >= cost:
            tokens -= cost
            self._buckets[bk] = (tokens, now)
            return Decision(True, limit.limit, int(tokens), 0, 0, policy.name, policy.algorithm)
        self._buckets[bk] = (tokens, now)
        retry = int((cost - tokens) * 1000 / limit.rate_per_second) + 1
        return Decision(False, limit.limit, int(tokens), retry, retry, policy.name, policy.algorithm)
