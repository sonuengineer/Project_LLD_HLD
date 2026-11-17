from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from redis.asyncio import BlockingConnectionPool, Redis

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api.routes import admin, public
from .config import Settings, get_settings
from .limiter.redis_limiter import RedisRateLimiter
from .services.api_keys import ApiKeyStore
from .services.policy_store import PolicyStore
from .services.rate_limit_service import RateLimitService


def create_app(settings: Settings | None = None, redis: Redis | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # BlockingConnectionPool: when all connections are busy, WAIT (up to pool_timeout)
        # instead of raising. The default pool raises MaxConnectionsError, which would be
        # treated as "Redis down" and silently fail-open exactly during a traffic spike.
        client = redis or Redis(connection_pool=BlockingConnectionPool.from_url(
            settings.redis_url, socket_timeout=settings.redis_socket_timeout,
            socket_connect_timeout=settings.redis_connect_timeout,
            max_connections=settings.redis_max_connections, timeout=settings.redis_pool_timeout,
        ))
        app.state.settings = settings
        app.state.redis = client
        app.state.policy_store = PolicyStore(client, settings.policies_file, settings.policy_cache_ttl_seconds)
        app.state.api_keys = ApiKeyStore(client, settings.api_key_cache_ttl_seconds)
        app.state.rate_limit_service = RateLimitService(RedisRateLimiter(client), app.state.policy_store)
        yield
        if redis is None:
            await client.aclose()

    app = FastAPI(title="Distributed Rate Limiter", version="1.0.0", lifespan=lifespan,
                  description="Redis + Lua rate limiting with 5 algorithms, plans, and fail-open/closed.")
    setup_app(app, "rate-limiter")
    app.include_router(public)
    app.include_router(admin)

    dashboard = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")

    @app.get("/dashboard", include_in_schema=False)
    async def _dashboard() -> HTMLResponse:
        return HTMLResponse(dashboard)

    return app


app = create_app()
