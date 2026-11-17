import asyncio
import time

from .conftest import client_for


async def test_concurrent_incr_is_exact(server):
    clients = [client_for(server) for _ in range(50)]

    async def worker(c):
        for _ in range(200):
            await c.incr("counter")

    await asyncio.gather(*[worker(c) for c in clients])
    assert await clients[0].get("counter") == b"10000"
    for c in clients:
        await c.aclose()


async def test_pipelining(server):
    c = client_for(server)
    async with c.pipeline(transaction=False) as p:
        for i in range(1000):
            p.set(f"k{i}", i)
        res = await p.execute()
    assert len(res) == 1000 and await c.dbsize() == 1000
    await c.aclose()


async def test_slow_command_blocks_all_clients(server):
    """Single-threaded execution: one slow command (like KEYS * on a big DB) stalls everyone."""
    slow, fast = client_for(server), client_for(server)
    await fast.ping()
    await slow.ping()  # open both TCP connections first so we time only the command
    t0 = time.perf_counter()
    task = asyncio.create_task(slow.execute_command("DEBUG", "SLEEP", "0.3"))
    await asyncio.sleep(0.02)
    await fast.ping()   # must wait for DEBUG SLEEP to finish
    assert time.perf_counter() - t0 >= 0.28
    await task
    await slow.aclose()
    await fast.aclose()


async def test_many_concurrent_clients(server):
    clients = [client_for(server) for _ in range(200)]
    results = await asyncio.gather(*[c.set(f"c{i}", i) for i, c in enumerate(clients)])
    assert all(results) and await clients[0].dbsize() == 200
    for c in clients:
        await c.aclose()
