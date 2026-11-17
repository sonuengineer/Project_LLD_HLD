"""python -m payments.worker -- periodic recovery of stuck/ambiguous payments and refunds."""
import asyncio
import contextlib
import logging

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from bpcommon.logging import configure_logging

from .config import get_settings
from .services.provider import HttpProvider
from .services.recovery import run_recovery

log = logging.getLogger(__name__)


async def main(interval: float = 15) -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    engine = create_async_engine(s.database_url)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    provider = HttpProvider(s.provider_url, s.provider_api_key, s.provider_timeout_seconds)
    try:
        while True:
            try:
                out = await run_recovery(sm, provider, s.stuck_after_seconds)
                if any(out.values()):
                    log.info("recovery_run", extra=out)
            except Exception:
                log.exception("recovery_loop_error")
            await asyncio.sleep(interval)
    finally:
        await provider.aclose()
        await engine.dispose()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
