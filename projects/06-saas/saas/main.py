from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import BlockingConnectionPool, Redis

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api.routes import admin, auth, billing, me, t
from .config import Settings, get_settings
from .db.session import make_engine, make_sessionmaker
from .services.billing import MockBillingProvider
from .services.cache import TenantCache
from .services.limits import TenantLimits


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = make_engine(settings.database_url)
        redis = Redis(connection_pool=BlockingConnectionPool.from_url(settings.redis_url, max_connections=50, timeout=2))
        app.state.settings = settings
        app.state.sm = make_sessionmaker(engine)
        app.state.redis = redis
        app.state.cache = TenantCache(redis, settings.cache_ttl_seconds)
        app.state.limits = TenantLimits(redis)
        app.state.billing = MockBillingProvider(settings.billing_webhook_secret)
        yield
        await redis.aclose()
        await engine.dispose()

    app = FastAPI(title="Multi-tenant SaaS", version="1.0.0", lifespan=lifespan,
                  description="Tenants, RBAC, plans, metering, API keys, audit logs, billing, RLS isolation.")
    setup_app(app, "saas")
    for r in (auth, me, t, billing, admin):
        app.include_router(r)
    return app


app = create_app()
