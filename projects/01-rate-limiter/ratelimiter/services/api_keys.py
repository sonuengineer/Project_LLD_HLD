"""API key store. Keys are stored HASHED (SHA-256), never in plaintext.

If Redis is dumped or leaked, the attacker gets hashes, not usable keys. SHA-256 (not
bcrypt) is fine here because API keys are long random strings, not human passwords,
so brute force is infeasible and we need a fast lookup on every request.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import dataclass

from redis.asyncio import Redis
from redis.exceptions import RedisError

from bpcommon.errors import ServiceUnavailable

from ..domain.models import Plan

KEY_PREFIX = "rl:apikey:"


@dataclass(frozen=True)
class ApiKeyRecord:
    key_id: str
    user_id: str
    plan: Plan


def hash_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


class ApiKeyStore:
    """Lookups are cached in-process for `cache_ttl` seconds.

    Why: auth runs on EVERY request; the cache removes one Redis round-trip and lets
    already-seen keys keep working through a short Redis blip.
    Cost: a revoked key keeps working on each instance for up to cache_ttl seconds.
    Unknown keys are cached too (negative cache) so a flood of bogus keys can't hammer Redis.
    """

    _MAX_ENTRIES = 50_000

    def __init__(self, redis: Redis, cache_ttl: float = 30.0):
        self._redis = redis
        self._ttl = cache_ttl
        self._cache: dict[str, tuple[float, ApiKeyRecord | None]] = {}

    async def create(self, user_id: str, plan: Plan, raw_key: str | None = None) -> tuple[str, ApiKeyRecord]:
        raw_key = raw_key or "rlk_" + secrets.token_urlsafe(24)
        record = ApiKeyRecord(key_id=hash_key(raw_key)[:16], user_id=user_id, plan=plan)
        await self._redis.set(KEY_PREFIX + hash_key(raw_key),
                              json.dumps({"key_id": record.key_id, "user_id": user_id, "plan": plan.value}))
        return raw_key, record  # raw key is returned exactly once, to the caller

    async def lookup(self, raw_key: str) -> ApiKeyRecord | None:
        digest = hash_key(raw_key)
        cached = self._cache.get(digest)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        try:
            data = await self._redis.get(KEY_PREFIX + digest)
        except RedisError as exc:
            # Authentication FAILS CLOSED: we can't tell a valid key from a forged one,
            # so we must not let the request through as if it were authenticated.
            raise ServiceUnavailable("Authentication backend unavailable",
                                     headers={"Retry-After": "1"}) from exc
        record = None
        if data:
            obj = json.loads(data)
            record = ApiKeyRecord(key_id=obj["key_id"], user_id=obj["user_id"], plan=Plan(obj["plan"]))
        if len(self._cache) >= self._MAX_ENTRIES:
            self._cache.clear()  # crude bound; an LRU would be the production choice
        self._cache[digest] = (time.monotonic() + self._ttl, record)
        return record

    async def revoke(self, raw_key: str) -> bool:
        digest = hash_key(raw_key)
        self._cache.pop(digest, None)  # this instance forgets immediately; others within TTL
        return bool(await self._redis.delete(KEY_PREFIX + digest))
