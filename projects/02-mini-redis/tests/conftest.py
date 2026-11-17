import contextlib
from pathlib import Path

import pytest
import redis.asyncio as R

from minidis.config import ServerConfig
from minidis.server import Server


@contextlib.asynccontextmanager
async def running(tmp: Path, **cfg):
    cfg.setdefault("save_rules", [])
    server = Server(ServerConfig(port=0, dir=tmp, **cfg))
    await server.start()
    try:
        yield server
    finally:
        await server.stop()


@pytest.fixture
async def server(tmp_path):
    async with running(tmp_path) as s:
        yield s


@pytest.fixture
async def r(server):
    client = R.Redis(host="127.0.0.1", port=server.port, protocol=2)
    yield client
    await client.aclose()


def client_for(server: Server, proto: int = 2) -> R.Redis:
    # 127.0.0.1, not "localhost": on Windows localhost resolves to ::1 first and the IPv6
    # attempt against an IPv4-only listener costs ~2s per connection before falling back.
    return R.Redis(host="127.0.0.1", port=server.port, protocol=proto)
