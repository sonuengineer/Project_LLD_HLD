"""Per-tenant rate limit (token bucket by plan) + monthly usage metering and quota."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import text

from bpcommon.errors import TooManyRequests

from ..core.plans import Plan
from .errors import QuotaExceeded

_BUCKET = """
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2])
local t = redis.call('TIME'); local now = t[1] * 1000 + math.floor(t[2] / 1000)
local s = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(s[1]) or cap; local ts = tonumber(s[2]) or now
tokens = math.min(cap, tokens + math.max(now - ts, 0) * rate / 1000)
local wait = 0
if tokens >= 1 then tokens = tokens - 1 else wait = math.ceil((1 - tokens) * 1000 / rate) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(cap * 1000 / rate) + 1000)
return wait
"""


def period(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m")


class TenantLimits:
    def __init__(self, redis: Redis):
        self.r = redis
        self._bucket = redis.register_script(_BUCKET)

    async def check_rate(self, tenant_id, plan: Plan) -> None:
        try:
            wait = int(await self._bucket(keys=[f"saas:rl:{tenant_id}"], args=[plan.burst, plan.requests_per_second]))
        except RedisError:
            return  # fail open: availability for paying customers over strict limiting
        if wait:
            raise TooManyRequests("tenant rate limit exceeded", details={"plan": plan.name},
                                  headers={"Retry-After": str(max(1, (wait + 999) // 1000))})

    async def meter(self, tenant_id, plan: Plan, metric: str = "api_calls") -> int:
        """INCR in Redis on the hot path (cheap); a background job folds it into Postgres."""
        key = f"saas:usage:{tenant_id}:{metric}:{period()}"
        try:
            pipe = self.r.pipeline(transaction=False)
            pipe.incr(key)
            pipe.expire(key, 40 * 24 * 3600)
            value = (await pipe.execute())[0]
        except RedisError:
            return 0
        if metric == "api_calls" and plan.monthly_api_calls is not None and value > plan.monthly_api_calls:
            raise QuotaExceeded(f"monthly API quota of {plan.monthly_api_calls} reached for plan {plan.name}",
                                details={"used": value, "limit": plan.monthly_api_calls})
        return value

    async def flush_usage_to_db(self, sm) -> int:
        """Copy Redis counters into usage_counters (idempotent: sets the absolute value, not +=)."""
        from ..db.session import tenant_tx
        n = 0
        async for key in self.r.scan_iter(match="saas:usage:*"):
            _, _, tenant_id, metric, per = key.decode().split(":", 4)
            value = int(await self.r.get(key) or 0)
            async with tenant_tx(sm, tenant_id) as s:
                await s.execute(text(
                    "INSERT INTO usage_counters (tenant_id, metric, period, value) VALUES (:t, :m, :p, :v) "
                    "ON CONFLICT (tenant_id, metric, period) DO UPDATE SET value = GREATEST(usage_counters.value, EXCLUDED.value)"),
                    {"t": tenant_id, "m": metric, "p": per, "v": value})
            n += 1
        return n


def now_ms() -> int:
    return int(time.time() * 1000)
