from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from redis.asyncio import BlockingConnectionPool, Redis
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api import router
from .config import Settings, get_settings
from .realtime import Hub


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=20, pool_pre_ping=True)
        redis = Redis(connection_pool=BlockingConnectionPool.from_url(settings.redis_url, max_connections=50, timeout=2))
        app.state.settings = settings
        app.state.sm = async_sessionmaker(engine, expire_on_commit=False)
        app.state.redis = redis
        app.state.hub = Hub(app.state.sm, redis, settings)
        await app.state.hub.start()
        yield
        await app.state.hub.stop()
        await redis.aclose()
        await engine.dispose()

    app = FastAPI(title="Collaborative Editing", version="1.0.0", lifespan=lifespan,
                  description="OT-based real-time document editing over WebSockets, horizontally scalable via Redis.")
    setup_app(app, "collab")
    app.include_router(router)
    page = Path(__file__).parent / "editor.html"

    @app.get("/editor", include_in_schema=False)
    async def editor() -> HTMLResponse:
        return HTMLResponse(page.read_text(encoding="utf-8"))

    return app


app = create_app()
