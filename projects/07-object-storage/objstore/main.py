from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from .api.routes import router
from .config import Settings, get_settings
from .storage.local import LocalAdapter


def make_storage(settings: Settings):
    if settings.storage_backend == "s3":
        from .storage.s3 import S3Adapter
        return S3Adapter(settings.s3_endpoint, settings.s3_bucket, settings.s3_access_key, settings.s3_secret_key,
                         settings.s3_region)
    return LocalAdapter(settings.local_root)


def create_app(settings: Settings | None = None, storage=None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=20, pool_pre_ping=True)
        app.state.settings = settings
        app.state.sm = async_sessionmaker(engine, expire_on_commit=False)
        app.state.storage = storage or make_storage(settings)
        from .services.auth import SecretCache
        app.state.secret_cache = SecretCache()
        if hasattr(app.state.storage, "ensure_bucket"):
            await app.state.storage.ensure_bucket()
        yield
        await engine.dispose()

    app = FastAPI(title="Object Storage", version="1.0.0", lifespan=lifespan,
                  description="S3-like buckets/objects with versioning, multipart, presigned URLs, lifecycle, quotas.")
    setup_app(app, "objstore")
    app.include_router(router)
    return app


app = create_app()
