"""Policies: defaults from policies.json, overrides stored in Redis.

Why Redis for overrides: with 3+ app instances, an admin change made through
instance A must reach instance B. Each instance caches policies locally for a few
seconds (policy_cache_ttl_seconds) so we don't add a Redis round-trip per request.
Trade-off: a change takes up to TTL seconds to apply everywhere (eventual consistency).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from redis.asyncio import Redis
from redis.exceptions import RedisError

from ..domain.models import Policy

log = logging.getLogger(__name__)
OVERRIDES_KEY = "rl:config:policies"


class PolicyStore:
    def __init__(self, redis: Redis, policies_file: Path, cache_ttl: float = 5.0):
        raw = json.loads(Path(policies_file).read_text(encoding="utf-8"))
        self._defaults = {p["name"]: Policy.model_validate(p) for p in raw["policies"]}
        self.route_groups: dict[str, list[str]] = raw["route_groups"]
        for group, names in self.route_groups.items():
            missing = [n for n in names if n not in self._defaults]
            if missing:
                raise ValueError(f"route group {group!r} references unknown policies {missing}")
        self._redis = redis
        self._ttl = cache_ttl
        self._cache: dict[str, Policy] = dict(self._defaults)
        self._loaded_at = 0.0

    async def _refresh(self) -> None:
        if time.monotonic() - self._loaded_at < self._ttl:
            return
        try:
            overrides = await self._redis.hgetall(OVERRIDES_KEY)
        except RedisError as exc:
            # Keep serving the last known policies; config staleness is better than outage.
            log.warning("policy_refresh_failed", extra={"error": str(exc)})
            self._loaded_at = time.monotonic()
            return
        merged = dict(self._defaults)
        for name, payload in overrides.items():
            name = name.decode() if isinstance(name, bytes) else name
            try:
                merged[name] = Policy.model_validate_json(payload)
            except ValueError:
                log.error("invalid_policy_override_ignored", extra={"policy": name})
        self._cache = merged
        self._loaded_at = time.monotonic()

    async def get_all(self) -> dict[str, Policy]:
        await self._refresh()
        return self._cache

    async def for_route_group(self, group: str) -> list[Policy]:
        policies = await self.get_all()
        names = self.route_groups.get(group, self.route_groups["default"])
        return [policies[n] for n in names]

    async def upsert(self, policy: Policy) -> None:
        if policy.name not in self._defaults:
            # Only existing policies can be tuned; adding a policy also needs a route group change (code review).
            raise KeyError(policy.name)
        await self._redis.hset(OVERRIDES_KEY, policy.name, policy.model_dump_json())
        self._loaded_at = 0.0  # this instance applies immediately; others within TTL

    async def reset(self, name: str) -> None:
        await self._redis.hdel(OVERRIDES_KEY, name)
        self._loaded_at = 0.0
