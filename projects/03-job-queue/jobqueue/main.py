from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from redis.asyncio import BlockingConnectionPool, Redis

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api.routes import router
from .config import Settings, get_settings
from .core.queue import JobQueue


def create_app(settings: Settings | None = None, redis: Redis | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = redis or Redis(connection_pool=BlockingConnectionPool.from_url(
            settings.redis_url, max_connections=50, timeout=2))
        app.state.settings = settings
        app.state.queue = JobQueue(client, settings.key_prefix, retention_s=settings.job_retention_seconds,
                                   completed_cap=settings.completed_cap,
                                   idempotency_ttl_s=settings.idempotency_ttl_seconds,
                                   lease_grace_ms=settings.lease_grace_ms)
        yield
        if redis is None:
            await client.aclose()

    app = FastAPI(title="Distributed Job Queue", version="1.0.0", lifespan=lifespan,
                  description="Priorities, delays, schedules, retries with jittered backoff, leases, DLQ.")
    setup_app(app, "job-queue")
    app.include_router(router)
    html = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")

    @app.get("/dashboard", include_in_schema=False)
    async def dashboard() -> HTMLResponse:
        return HTMLResponse(html)

    return app


app = create_app()
