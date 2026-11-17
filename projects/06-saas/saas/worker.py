"""python -m saas.worker -- processes tenant-aware jobs (and flushes usage counters every minute)."""
import asyncio
import contextlib
import time

from redis.asyncio import Redis

from bpcommon.logging import configure_logging

from .config import get_settings
from .db.session import make_engine, make_sessionmaker
from .services.jobs import process_one
from .services.limits import TenantLimits


async def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    redis, engine = Redis.from_url(s.redis_url), make_engine(s.database_url)
    sm, limits = make_sessionmaker(engine), TenantLimits(redis)
    last_flush = 0.0
    try:
        while True:
            await process_one(redis, sm, timeout=1.0)
            if time.monotonic() - last_flush > 60:
                await limits.flush_usage_to_db(sm)
                last_flush = time.monotonic()
    finally:
        await redis.aclose()
        await engine.dispose()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
