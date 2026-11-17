"""Throughput through the real API (ASGI in-process, real Postgres, real storage).
    python bench/throughput.py [local|s3|both]"""
import asyncio
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from objstore.client import ObjClient  # noqa: E402
from objstore.config import Settings  # noqa: E402
from objstore.main import create_app  # noqa: E402
from objstore.storage.local import LocalAdapter  # noqa: E402
from objstore.storage.s3 import S3Adapter  # noqa: E402
from tests.conftest import DB_URL, TABLES  # noqa: E402


async def run(backend: str):
    eng = create_async_engine(DB_URL)
    async with eng.begin() as c:
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
        await c.execute(text("INSERT INTO access_keys (access_key_id, secret, owner) VALUES ('BENCH', 's', 'bench')"))
    await eng.dispose()
    tmp = tempfile.mkdtemp()
    storage = LocalAdapter(tmp) if backend == "local" else S3Adapter("http://127.0.0.1:58333", f"bench-{uuid.uuid4().hex[:6]}", "a", "b")
    app = create_app(Settings(database_url=DB_URL, local_root=tmp, log_level="ERROR", log_json=False), storage=storage)
    async with app.router.lifespan_context(app):
        c = ObjClient("http://obj", "BENCH", "s", httpx.ASGITransport(app=app))
        await c.request("PUT", "/buckets/bench")
        n, small = 300, os.urandom(1024)
        sem = asyncio.Semaphore(16)

        async def put(i):
            async with sem:
                assert (await c.put("bench", f"small/{i}", small, md5=False)).status_code == 200

        async def get(i):
            async with sem:
                assert len((await c.get("bench", f"small/{i}")).content) == 1024

        t = time.perf_counter()
        await asyncio.gather(*[put(i) for i in range(n)])
        put_rate = n / (time.perf_counter() - t)
        t = time.perf_counter()
        await asyncio.gather(*[get(i) for i in range(n)])
        get_rate = n / (time.perf_counter() - t)
        print(f"[{backend}] 1KB objects, 16 concurrent: PUT {put_rate:,.0f} ops/s  GET {get_rate:,.0f} ops/s")
        big = os.urandom(64 * 1024 * 1024)
        t = time.perf_counter()
        for i in range(3):
            assert (await c.put("bench", f"big/{i}", big, md5=False)).status_code == 200
        up = 3 * 64 / (time.perf_counter() - t)
        t = time.perf_counter()
        for i in range(3):
            assert len((await c.get("bench", f"big/{i}")).content) == len(big)
        down = 3 * 64 / (time.perf_counter() - t)
        print(f"[{backend}] 64MB objects, sequential: PUT {up:,.0f} MB/s  GET {down:,.0f} MB/s")
        await c.aclose()


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    for b in (["local", "s3"] if which == "both" else [which]):
        asyncio.run(run(b))
