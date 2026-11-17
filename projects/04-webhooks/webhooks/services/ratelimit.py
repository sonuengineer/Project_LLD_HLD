"""Per-endpoint token bucket in Redis (same atomic-Lua idea as Project 1).

Why per endpoint: one customer's slow server must not receive 10k requests/second during a
backlog flush, and many dispatchers must share ONE budget per endpoint -> Redis, not memory.
"""
from __future__ import annotations

from redis.asyncio import Redis
from redis.exceptions import RedisError

_LUA = """
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


class EndpointRateLimiter:
    def __init__(self, redis: Redis):
        self._script = redis.register_script(_LUA)

    async def acquire(self, endpoint_id: str, per_second: float) -> int:
        """0 = go ahead, otherwise milliseconds to wait. Fails OPEN on Redis errors: a Redis
        outage should slow nothing down; endpoints are protected again once Redis is back."""
        burst = max(1.0, per_second)
        try:
            return int(await self._script(keys=[f"wh:rl:{endpoint_id}"], args=[burst, per_second]))
        except RedisError:
            return 0
