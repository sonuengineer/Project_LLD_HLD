"""Tenant-aware cache. Every key is namespaced by tenant id:  saas:cache:{tenant_id}:{name}

Why it matters: a cache key like "projects:list" (without the tenant) would serve tenant A's list
to tenant B -- a data leak that RLS can't catch because the database is never asked.
Invalidation is explicit after writes; TTL bounds staleness if an invalidation is missed.
"""
from __future__ import annotations

import json
import uuid
from typing import Awaitable, Callable

from redis.asyncio import Redis
from redis.exceptions import RedisError


class TenantCache:
    def __init__(self, redis: Redis, ttl: int = 60):
        self.r, self.ttl = redis, ttl
        self.hits = self.misses = 0

    @staticmethod
    def key(tenant_id: uuid.UUID | str, name: str) -> str:
        return f"saas:cache:{tenant_id}:{name}"

    async def get_or_load(self, tenant_id, name: str, loader: Callable[[], Awaitable]):
        k = self.key(tenant_id, name)
        try:
            raw = await self.r.get(k)
            if raw is not None:
                self.hits += 1
                return json.loads(raw)
        except RedisError:
            return await loader()   # cache is an optimisation: never fail the request because of it
        self.misses += 1
        value = await loader()
        try:
            await self.r.set(k, json.dumps(value, default=str), ex=self.ttl)
        except RedisError:
            pass
        return value

    async def invalidate(self, tenant_id, *names: str) -> None:
        try:
            await self.r.delete(*[self.key(tenant_id, n) for n in names])
        except RedisError:
            pass
