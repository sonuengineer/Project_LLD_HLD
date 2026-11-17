"""python -m jobqueue.worker --queues critical,default,low --concurrency 8"""
import argparse
import asyncio
import contextlib
import signal

from redis.asyncio import BlockingConnectionPool, Redis

from bpcommon.logging import configure_logging

from ..config import get_settings
from ..core.queue import JobQueue
from ..db.session import make_engine, make_sessionmaker
from ..handlers.builtin import registry
from .worker import Worker


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queues", default="critical,default,low")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--worker-id", default=None)
    a = ap.parse_args()
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    redis = Redis(connection_pool=BlockingConnectionPool.from_url(s.redis_url, max_connections=a.concurrency + 8,
                                                                  timeout=5))
    engine = make_engine(s.database_url)
    q = JobQueue(redis, s.key_prefix, retention_s=s.job_retention_seconds, completed_cap=s.completed_cap,
                 idempotency_ttl_s=s.idempotency_ttl_seconds, lease_grace_ms=s.lease_grace_ms)
    w = Worker(q, registry, a.queues.split(","), concurrency=a.concurrency,
               sessionmaker=make_sessionmaker(engine), worker_id=a.worker_id,
               max_lease_ms=s.max_lease_ms, reap_interval=s.reap_interval_seconds)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, w.stop)
    try:
        await w.run()
    finally:
        await redis.aclose()
        await engine.dispose()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
