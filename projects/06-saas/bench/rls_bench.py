"""What does RLS cost, and does the tenant-leading index carry it?
Loads 100 tenants x 1000 projects into the TEST database, then times the hot query as the app role.
    python bench/rls_bench.py"""
import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import text  # noqa: E402

from saas.db.session import make_engine, make_sessionmaker, tenant_tx  # noqa: E402
from tests.conftest import APP_URL, OWNER_URL, TABLES  # noqa: E402

Q = "SELECT id, name FROM projects ORDER BY created_at DESC LIMIT 20"


async def timeit(sm, tid, n=300):
    lat = []
    for _ in range(n):
        t = time.perf_counter()
        async with tenant_tx(sm, tid) as s:
            await s.execute(text(Q))
        lat.append((time.perf_counter() - t) * 1000)
    lat.sort()
    return statistics.median(lat), lat[int(len(lat) * .95)]


async def main():
    owner = make_engine(OWNER_URL)
    async with owner.begin() as c:
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
        await c.execute(text("INSERT INTO tenants (slug, name) SELECT 'tenant-' || g, 'T' || g FROM generate_series(1, 100) g"))
        await c.execute(text("INSERT INTO projects (tenant_id, name, created_at) SELECT t.id, 'p' || g, now() - g * interval '1 minute' "
                             "FROM tenants t CROSS JOIN generate_series(1, 1000) g"))
        await c.execute(text("ANALYZE projects"))
        tid = await c.scalar(text("SELECT id FROM tenants WHERE slug = 'tenant-50'"))
    sm = make_sessionmaker(make_engine(APP_URL))
    async with tenant_tx(sm, tid) as s:
        plan = "\n".join(r[0] for r in await s.execute(text("EXPLAIN (ANALYZE, COSTS OFF) " + Q)))
    print("rows: 100 tenants x 1000 projects = 100,000\n--- plan with RLS + index (tenant_id, created_at DESC):\n" + plan)
    p50, p95 = await timeit(sm, tid)
    print(f"--- latency (app role, RLS, full tx round trip incl. set_config): p50={p50:.2f}ms p95={p95:.2f}ms")
    async with owner.begin() as c:
        await c.execute(text("DROP INDEX ix_projects_tenant_created"))
    async with tenant_tx(sm, tid) as s:
        plan = "\n".join(r[0] for r in await s.execute(text("EXPLAIN (ANALYZE, COSTS OFF) " + Q)))
    print("--- plan WITHOUT the tenant index:\n" + plan)
    p50, p95 = await timeit(sm, tid)
    print(f"--- latency without index: p50={p50:.2f}ms p95={p95:.2f}ms")
    async with owner.begin() as c:
        await c.execute(text("CREATE INDEX ix_projects_tenant_created ON projects (tenant_id, created_at DESC)"))
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    await owner.dispose()


asyncio.run(main())
