"""End-to-end payments throughput (authorize + capture + ledger), in-process apps, real Postgres.
    python bench/throughput.py"""
import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from tests.conftest import DB_URL, TABLES, pay, system  # noqa: E402


async def main():
    eng = create_async_engine(DB_URL)
    async with eng.begin() as c:
        await c.execute(text("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update"))
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
        await c.execute(text("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update"))
    await eng.dispose()
    async with system(timeout=5) as c:
        for conc, n in ((1, 100), (16, 400)):
            sem = asyncio.Semaphore(conc)
            lat = []

            async def one(i):
                async with sem:
                    t = time.perf_counter()
                    r = await pay(c, f"bench-{conc}-{i}", ref=f"bench-{conc}-{i}")
                    assert r.json()["status"] == "captured", r.text
                    lat.append((time.perf_counter() - t) * 1000)
            t0 = time.perf_counter()
            await asyncio.gather(*[one(i) for i in range(n)])
            el = time.perf_counter() - t0
            lat.sort()
            print(f"concurrency={conc:<3} {n / el:6.1f} payments/s (authorize+capture+ledger)  "
                  f"p50={statistics.median(lat):.1f}ms p95={lat[int(len(lat) * .95)]:.1f}ms")
        t = time.perf_counter()
        for i in range(100):
            assert (await pay(c, "bench-1-0", ref="bench-1-0")).headers.get("idempotent-replayed") == "true"
        print(f"idempotent replay: {(time.perf_counter() - t) * 10:.2f} ms per request (no provider call)")
        async with c.app.state.sm() as s:
            print("trial balance (sum of all ledger entries):", await s.scalar(text("SELECT coalesce(sum(amount),0) FROM ledger_entries")))


asyncio.run(main())
