"""Redis-backed limiter. Each algorithm is ONE Lua script, so the read-modify-write
is atomic: Redis executes a script without interleaving any other command.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import RedisError, TimeoutError as RedisTimeoutError

from ..domain.models import Algorithm, Decision, Policy, PlanLimit
from .base import BackendUnavailable

_LUA_DIR = Path(__file__).parent / "lua"
KEY_PREFIX = "rl"


def _load(name: str) -> str:
    return (_LUA_DIR / f"{name}.lua").read_text(encoding="utf-8")


class RedisRateLimiter:
    def __init__(self, redis: Redis):
        self._redis = redis
        # register_script uses EVALSHA (script sent once, then referenced by SHA1)
        # and transparently falls back to EVAL on NOSCRIPT (e.g. after Redis restart).
        self._scripts = {alg: redis.register_script(_load(alg.value)) for alg in Algorithm}

    @staticmethod
    def build_key(policy: Policy, key: str) -> str:
        # The {hash tag} keeps all keys of one identity on the same Redis Cluster slot,
        # which matters for sliding_counter (it touches two keys in one script).
        return f"{KEY_PREFIX}:{policy.name}:{{{key}}}"

    def _args(self, policy: Policy, limit: PlanLimit, cost: int, now_ms: int | None) -> list:
        now = "" if now_ms is None else str(now_ms)
        alg = policy.algorithm
        if alg in (Algorithm.TOKEN_BUCKET, Algorithm.LEAKY_BUCKET):
            return [limit.limit, limit.rate_per_second, now, cost]
        window_ms = int(limit.window_seconds * 1000)
        args = [limit.limit, window_ms, now, cost]
        if alg is Algorithm.SLIDING_LOG:
            args.append(uuid.uuid4().hex)  # unique ZSET member per request
        return args

    async def check(self, key: str, policy: Policy, limit: PlanLimit, *, cost: int = 1,
                    now_ms: int | None = None) -> Decision:
        script = self._scripts[policy.algorithm]
        try:
            allowed, remaining, retry_ms, reset_ms = await script(
                keys=[self.build_key(policy, key)], args=self._args(policy, limit, cost, now_ms)
            )
        except (RedisConnectionError, RedisTimeoutError, OSError) as exc:
            raise BackendUnavailable(str(exc)) from exc
        except RedisError as exc:  # e.g. READONLY replica, OOM -> treat as unavailable too
            raise BackendUnavailable(str(exc)) from exc
        return Decision(
            allowed=bool(allowed), limit=limit.limit, remaining=int(remaining),
            retry_after_ms=int(retry_ms), reset_ms=int(reset_ms),
            policy=policy.name, algorithm=policy.algorithm,
        )
