from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api.routes import router
from .config import Settings, get_settings
from .services.provider import HttpProvider


def create_app(settings: Settings | None = None, provider=None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=20, pool_pre_ping=True)
        app.state.settings = settings
        app.state.sm = async_sessionmaker(engine, expire_on_commit=False)
        app.state.provider = provider or HttpProvider(settings.provider_url, settings.provider_api_key,
                                                      settings.provider_timeout_seconds)
        yield
        if provider is None:
            await app.state.provider.aclose()
        await engine.dispose()

    app = FastAPI(title="Payments", version="1.0.0", lifespan=lifespan,
                  description="Payment state machine, idempotency keys, double-entry ledger, recovery, reconciliation, saga. "
                              "Mock provider only -- never real money.")
    setup_app(app, "payments")
    app.include_router(router)
    html = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")

    @app.get("/dashboard", include_in_schema=False)
    async def dashboard() -> HTMLResponse:
        return HTMLResponse(html)

    return app


app = create_app()
