"""python -m webhooks.dispatcher"""
import asyncio
import contextlib
import signal

from redis.asyncio import BlockingConnectionPool, Redis

from bpcommon.logging import configure_logging

from ..config import get_settings
from ..db.session import make_engine, make_sessionmaker
from ..services.ratelimit import EndpointRateLimiter
from .dispatcher import Dispatcher


async def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    engine = make_engine(s.database_url)
    redis = Redis(connection_pool=BlockingConnectionPool.from_url(
        s.redis_url, max_connections=20, timeout=2, socket_timeout=0.5, socket_connect_timeout=0.5))
    d = Dispatcher(s, make_sessionmaker(engine), EndpointRateLimiter(redis))
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, d.stop)
    try:
        await d.run()
    finally:
        await d.aclose()
        await redis.aclose()
        await engine.dispose()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
