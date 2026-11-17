from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api.routes import router
from .config import Settings, get_settings
from .db.session import make_engine, make_sessionmaker


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = make_engine(settings.database_url)
        app.state.settings = settings
        app.state.sessionmaker = make_sessionmaker(engine)
        yield
        await engine.dispose()

    app = FastAPI(title="Webhook Delivery", version="1.0.0", lifespan=lifespan,
                  description="Signed, retried, rate-limited webhook delivery with replay and secret rotation.")
    setup_app(app, "webhooks")
    app.include_router(router)
    html = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")

    @app.get("/dashboard", include_in_schema=False)
    async def dashboard() -> HTMLResponse:
        return HTMLResponse(html)

    return app


app = create_app()
