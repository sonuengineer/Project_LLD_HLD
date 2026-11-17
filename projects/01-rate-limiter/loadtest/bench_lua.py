"""Micro-benchmark: cost of ONE limiter check (one EVALSHA) per algorithm, straight against Redis.

    python loadtest/bench_lua.py --redis redis://127.0.0.1:56379/14 --checks 20000 --concurrency 50
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from redis.asyncio import BlockingConnectionPool, Redis  # noqa: E402

from ratelimiter.domain.models import Algorithm, PlanLimit, Policy, Scope  # noqa: E402
from ratelimiter.limiter.redis_limiter import RedisRateLimiter  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--redis", default="redis://127.0.0.1:56379/14")
    ap.add_argument("--checks", type=int, default=20000)
    ap.add_argument("--concurrency", type=int, default=50)
    a = ap.parse_args()
    redis = Redis(connection_pool=BlockingConnectionPool.from_url(a.redis, max_connections=a.concurrency))
    await redis.flushdb()
    lim = RedisRateLimiter(redis)
    print(f"checks={a.checks} concurrency={a.concurrency} keys=1000 distinct identities")
    for alg in Algorithm:
        windowed = alg in (Algorithm.FIXED_WINDOW, Algorithm.SLIDING_LOG, Algorithm.SLIDING_COUNTER)
        pl = PlanLimit(limit=100, window_seconds=60 if windowed else None, rate_per_second=None if windowed else 10)
        p = Policy(name=f"bench_{alg.value}", algorithm=alg, scope=Scope.IP, plans={}, default=pl)
        sem = asyncio.Semaphore(a.concurrency)
        lat: list[float] = []

        async def one(i: int) -> None:
            async with sem:
                t = time.perf_counter()
                await lim.check(f"user{i % 1000}", p, pl)
                lat.append((time.perf_counter() - t) * 1000)

        t0 = time.perf_counter()
        await asyncio.gather(*[one(i) for i in range(a.checks)])
        el = time.perf_counter() - t0
        lat.sort()
        print(f"{alg.value:<16} {a.checks / el:>8.0f} checks/s   p50={lat[len(lat) // 2]:.2f}ms  p99={lat[int(len(lat) * .99)]:.2f}ms")
    await redis.flushdb()
    await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
