"""Edit propagation latency and sequencer throughput with real servers.
    python bench/latency.py
Measures (a) time from client A's edit to client B seeing it (same server vs across servers via Redis),
(b) committed ops/second with N concurrent writers on one document (the per-document row lock is the limit)."""
import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collab.client import CollabClient  # noqa: E402
from tests.conftest import Api, run_server  # noqa: E402


async def propagation(ws_a, ws_b, api, u, doc_id, n=100):
    a, b = CollabClient(ws_a, doc_id, api.ticket_factory(u)), CollabClient(ws_b, doc_id, api.ticket_factory(u))
    await a.connect()
    await b.connect()
    lat = []
    for i in range(n):
        target = b.received_ops + 1
        t = time.perf_counter()
        await a.insert(len(a.doc), "x")
        while b.received_ops < target:
            await asyncio.sleep(0)
        lat.append((time.perf_counter() - t) * 1000)
        while not a.settled:
            await asyncio.sleep(0)
    await a.disconnect()
    await b.disconnect()
    lat.sort()
    return statistics.median(lat), lat[int(len(lat) * .95)]


async def throughput(ws, api, u, doc_id, writers=8, per=50):
    cs = [CollabClient(ws, doc_id, api.ticket_factory(u)) for _ in range(writers)]
    for c in cs:
        await c.connect()

    async def go(c):
        for _ in range(per):
            await c.insert(0, "y")
            while not c.settled:
                await asyncio.sleep(0)
    t = time.perf_counter()
    await asyncio.gather(*[go(c) for c in cs])
    el = time.perf_counter() - t
    for c in cs:
        await c.disconnect()
    return writers * per / el


async def main():
    from tests.conftest import DB_URL  # noqa
    async with run_server("b1") as (_, base1, ws1), run_server("b2") as (_, base2, ws2):
        api = Api(base1)
        u = await api.user("bench")
        d1 = (await api.http.post("/docs", json={"title": "b1"}, headers=api.h(u))).json()["id"]
        d2 = (await api.http.post("/docs", json={"title": "b2"}, headers=api.h(u))).json()["id"]
        d3 = (await api.http.post("/docs", json={"title": "b3"}, headers=api.h(u))).json()["id"]
        p50, p95 = await propagation(ws1, ws1, api, u, d1)
        print(f"propagation A->B same server:    p50={p50:.1f}ms p95={p95:.1f}ms (100 edits)")
        p50, p95 = await propagation(ws1, ws2, api, u, d2)
        print(f"propagation A->B across servers: p50={p50:.1f}ms p95={p95:.1f}ms (via Redis pub/sub)")
        for w in (1, 8):
            r = await throughput(ws1, api, u, d3, writers=w)
            print(f"committed ops/s on ONE document, {w} concurrent writer(s): {r:.0f}")


asyncio.run(main())
