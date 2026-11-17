"""python -m objstore.worker -- runs lifecycle rules and garbage collection periodically.
Safe to run on several instances: lifecycle deletes are idempotent and GC re-checks references."""
import asyncio
import contextlib
import logging

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from bpcommon.logging import configure_logging

from .config import get_settings
from .main import make_storage
from .services.maintenance import run_gc, run_lifecycle

log = logging.getLogger(__name__)


async def main(interval: float = 300) -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    engine = create_async_engine(s.database_url)
    sm, storage = async_sessionmaker(engine, expire_on_commit=False), make_storage(s)
    if hasattr(storage, "ensure_bucket"):
        await storage.ensure_bucket()
    try:
        while True:
            try:
                log.info("lifecycle_run", extra=await run_lifecycle(sm, storage))
                log.info("gc_run", extra=await run_gc(sm, storage, s.orphan_grace_seconds, s.deletion_grace_seconds))
            except Exception:
                log.exception("maintenance_failed")
            await asyncio.sleep(interval)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
