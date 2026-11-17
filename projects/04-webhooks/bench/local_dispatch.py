"""In-process dispatcher benchmark (no Docker network): Postgres test DB + real receiver via ASGI.
Isolates dispatcher efficiency. python bench/local_dispatch.py [n] [endpoints]"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from redis.asyncio import Redis  # noqa: E402
from sqlalchemy import text  # noqa: E402

from tests.conftest import DB_URL, REDIS_URL, make_settings  # noqa: E402
from tests.helpers import add_endpoint, receiver  # noqa: E402
from webhooks.db.session import make_engine, make_sessionmaker  # noqa: E402
from webhooks.dispatcher.dispatcher import Dispatcher  # noqa: E402
from webhooks.services.events import EventCreate, publish  # noqa: E402
from webhooks.services.ratelimit import EndpointRateLimiter  # noqa: E402


async def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    n_eps = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    engine = make_engine(DB_URL)
    async with engine.begin() as c:
        await c.execute(text("TRUNCATE delivery_attempts, deliveries, events, endpoints RESTART IDENTITY CASCADE"))
    sm = make_sessionmaker(engine)
    redis = Redis.from_url(REDIS_URL)
    await redis.flushdb()
    secrets = [(await add_endpoint(sm))[1] for _ in range(n_eps)]
    async with sm() as s, s.begin():
        for i in range(n):
            await publish(s, EventCreate(type="bench.tick", payload={"i": i}))
    d = Dispatcher(make_settings(log_level="ERROR"), sm, EndpointRateLimiter(redis), transport=receiver(secrets))
    t0 = time.perf_counter()
    total = 0
    while (k := await d.run_once()):
        total += k
    el = time.perf_counter() - t0
    print(f"{total} deliveries to {n_eps} endpoint(s) in {el:.2f}s -> {total / el:.0f}/s  stats={d.stats}")
    await d.aclose()
    await redis.aclose()
    await engine.dispose()


asyncio.run(main())
