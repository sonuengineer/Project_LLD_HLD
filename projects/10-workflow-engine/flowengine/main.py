from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from . import examples  # noqa: F401  (registers example workflows/activities)
from .api import router
from .config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=10, pool_pre_ping=True)
        app.state.settings = settings
        app.state.sm = async_sessionmaker(engine, expire_on_commit=False)
        yield
        await engine.dispose()

    app = FastAPI(title="Workflow Engine", version="1.0.0", lifespan=lifespan,
                  description="Durable workflows: event-sourced history, deterministic replay, activities with retries, "
                              "timers, signals, cancellation.")
    setup_app(app, "flowengine")
    app.include_router(router)
    html = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")

    @app.get("/dashboard", include_in_schema=False)
    async def dashboard() -> HTMLResponse:
        return HTMLResponse(html)

    return app


app = create_app()
