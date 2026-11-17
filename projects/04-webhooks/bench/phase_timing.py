"""Where does a delivery's time go? Wraps dispatcher phases with timers. python bench/phase_timing.py"""
import asyncio
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from redis.asyncio import Redis  # noqa: E402
from sqlalchemy import text  # noqa: E402

from tests.conftest import DB_URL, REDIS_URL, make_settings  # noqa: E402
from tests.helpers import add_endpoint, receiver  # noqa: E402
from webhooks.db.session import make_engine, make_sessionmaker  # noqa: E402
from webhooks.dispatcher import dispatcher as mod  # noqa: E402
from webhooks.services.events import EventCreate, publish  # noqa: E402
from webhooks.services.ratelimit import EndpointRateLimiter  # noqa: E402

T = defaultdict(float)
N = defaultdict(int)


def timed(name, fn):
    async def w(*a, **k):
        t = time.perf_counter()
        try:
            return await fn(*a, **k)
        finally:
            T[name] += time.perf_counter() - t
            N[name] += 1
    return w


async def main():
    engine = make_engine(DB_URL)
    async with engine.begin() as c:
        await c.execute(text("TRUNCATE delivery_attempts, deliveries, events, endpoints RESTART IDENTITY CASCADE"))
    sm = make_sessionmaker(engine)
    redis = Redis.from_url(REDIS_URL)
    _, secret = await add_endpoint(sm)
    async with sm() as s, s.begin():
        for i in range(300):
            await publish(s, EventCreate(type="bench.tick", payload={"i": i}))
    import os
    d = mod.Dispatcher(make_settings(log_level="ERROR"), sm, EndpointRateLimiter(redis), transport=receiver([secret]),
                       concurrency=int(os.getenv("CONC", "20")), batch_size=int(os.getenv("BATCH", "20")))
    for name in ("claim", "deliver", "_send", "_record"):
        setattr(d, name, timed(name, getattr(d, name)))
    d.limiter.acquire = timed("ratelimit", d.limiter.acquire)
    t0, c0 = time.perf_counter(), time.process_time()
    while await d.run_once():
        pass
    el, cpu = time.perf_counter() - t0, time.process_time() - c0
    print(f"wall {el:.2f}s for 300 deliveries, process CPU {cpu:.2f}s ({cpu / el:.0%} of wall)")
    for k in T:
        print(f"{k:<10} calls={N[k]:<4} avg={T[k] / N[k] * 1000:7.1f} ms")
    await d.aclose()
    await redis.aclose()
    await engine.dispose()


asyncio.run(main())
