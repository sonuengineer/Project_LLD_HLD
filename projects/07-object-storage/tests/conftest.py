import contextlib
import os

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from objstore.client import ObjClient
from objstore.config import Settings
from objstore.main import create_app
from objstore.storage.local import LocalAdapter

DB_URL = os.getenv("OBJ_TEST_DATABASE_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p07_object_store_test")
TABLES = "blob_deletions, lifecycle_rules, multipart_parts, multipart_uploads, objects, bucket_grants, buckets, access_keys"
KEYS = {"admin": ("OBJADMIN", "admin-secret", True), "alice": ("OBJALICE", "alice-secret", False),
        "bob": ("OBJBOB", "bob-secret", False)}


@pytest.fixture
async def db():
    engine = create_async_engine(DB_URL)
    async with engine.begin() as c:
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
        for owner, (ak, sk, adm) in KEYS.items():
            await c.execute(text("INSERT INTO access_keys (access_key_id, secret, owner, is_admin) VALUES (:a, :s, :o, :ad)"),
                            {"a": ak, "s": sk, "o": owner, "ad": adm})
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@contextlib.asynccontextmanager
async def server(tmp_path, storage=None, **cfg):
    base = dict(database_url=DB_URL, local_root=str(tmp_path / "blobs"), min_part_bytes=5, log_json=False,
                log_level="WARNING", public_base_url="http://obj")
    base.update(cfg)
    app = create_app(Settings(**base), storage=storage or LocalAdapter(str(tmp_path / "blobs")))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        clients = {name: ObjClient("http://obj", ak, sk, transport) for name, (ak, sk, _) in KEYS.items()}
        anon = httpx.AsyncClient(transport=transport, base_url="http://obj")
        yield app, clients, anon
        for c in clients.values():
            await c.aclose()
        await anon.aclose()
