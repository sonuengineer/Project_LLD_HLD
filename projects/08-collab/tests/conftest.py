import asyncio
import contextlib
import os
import socket

import httpx
import pytest
import uvicorn
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from collab.config import Settings
from collab.main import create_app

DB_URL = os.getenv("COLLAB_TEST_DATABASE_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p08_collab_test")
REDIS_URL = os.getenv("COLLAB_TEST_REDIS_URL", "redis://127.0.0.1:56379/9")


@pytest.fixture
async def clean():
    eng = create_async_engine(DB_URL)
    async with eng.begin() as c:
        await c.execute(text("TRUNCATE snapshots, operations, document_permissions, documents, users CASCADE"))
    await eng.dispose()
    r = Redis.from_url(REDIS_URL)
    await r.flushdb()
    await r.aclose()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.asynccontextmanager
async def run_server(server_id: str, **cfg):
    settings = Settings(database_url=DB_URL, redis_url=REDIS_URL, server_id=server_id, log_json=False,
                        log_level="WARNING", **cfg)
    app = create_app(settings)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets-sansio"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    try:
        yield app, f"http://127.0.0.1:{port}", f"ws://127.0.0.1:{port}/ws"
    finally:
        server.should_exit = True
        await task


class Api:
    def __init__(self, base: str):
        self.http = httpx.AsyncClient(base_url=base, timeout=30)

    async def user(self, name: str) -> dict:
        r = await self.http.post("/users", json={"name": name})
        return r.json()

    def h(self, u):
        return {"Authorization": f"Bearer {u['token']}"}

    def ticket_factory(self, u):
        async def get():
            return (await self.http.post("/ws-tickets", headers=self.h(u))).json()["ticket"]
        return get
