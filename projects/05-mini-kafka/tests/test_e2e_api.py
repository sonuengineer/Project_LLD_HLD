"""Producer + consumer clients against the real HTTP API (ASGI transport, real cluster underneath)."""
import asyncio
import contextlib
from collections import Counter, defaultdict

import httpx

from minikafka.api.app import create_app
from minikafka.client.consumer import Consumer
from minikafka.client.producer import Producer

from .conftest import eventually, fast_config

ADMIN = {"X-Admin-Token": "t"}


@contextlib.asynccontextmanager
async def api(tmp_path, **kw):
    app = create_app(fast_config(tmp_path, **kw), admin_token="t")
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://mk") as http:
            yield app, transport, http


def consumer(transport, group, **kw):
    kw.setdefault("session_timeout_ms", 500)
    kw.setdefault("heartbeat_interval_ms", 50)
    return Consumer(group, ["orders"], base_url="http://mk", transport=transport, **kw)


async def drain(consumers, want, timeout=10.0):
    """Run every consumer in its OWN task, like separate processes. (Polling them one after another
    from a single loop deadlocks rebalances: B's join waits for A to re-join, A waits for B's call.)"""
    got = []
    done = asyncio.Event()

    async def run(c):
        while not done.is_set():
            batch = await c.poll(wait_ms=50)
            got.extend(batch)
            if batch:
                await c.commit()
            if len({(r.partition, r.offset) for r in got}) >= want:
                done.set()

    tasks = [asyncio.create_task(run(c)) for c in consumers]
    try:
        await asyncio.wait_for(done.wait(), timeout)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return got


async def stable(http, group, consumers, timeout=5.0):
    """Wait until every consumer has caught up with the group's current generation."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        g = (await http.get(f"/groups/{group}")).json()
        if g["state"] == "Stable" and all(c.generation == g["generation"] for c in consumers):
            return g
        for c in consumers:
            await c.poll(wait_ms=10)
    raise AssertionError("group never stabilised")


async def test_key_ordering_and_group_consumption(tmp_path):
    async with api(tmp_path) as (app, transport, http):
        assert (await http.post("/topics", json={"name": "orders", "partitions": 4, "replication_factor": 3,
                                                 "min_insync_replicas": 2})).status_code == 201
        p = Producer("http://mk", transport=transport, linger_ms=2)
        futs = [await p.send("orders", f"{user}:{i}", key=user) for i in range(25) for user in ("u1", "u2", "u3", "u4")]
        await p.flush()
        results = [await f for f in futs]
        by_key = defaultdict(set)
        for (part, _), f in zip(results, [(u) for i in range(25) for u in ("u1", "u2", "u3", "u4")]):
            by_key[f].add(part)
        assert all(len(v) == 1 for v in by_key.values())        # each key -> exactly one partition
        a, b = consumer(transport, "billing"), consumer(transport, "billing")
        records = await drain([a, b], 100)
        unique = {(r.partition, r.offset): r for r in records}
        assert len(unique) == 100                    # nothing lost (duplicates possible during rebalance)
        records = list(unique.values())
        for user in ("u1", "u2", "u3", "u4"):                   # per-key order preserved
            seq = [int(r.value.split(":")[1]) for r in sorted(records, key=lambda r: (r.partition, r.offset))
                   if r.key == user]
            assert seq == list(range(25))
        await stable(http, "billing", [a, b])
        assert set(a.assignment).isdisjoint(b.assignment) and len(a.assignment) + len(b.assignment) == 4
        lag = (await http.get("/groups/billing")).json()["lag"]
        assert sum(x["lag"] for x in lag) == 0
        await a.close()
        await b.close()
        await p.close()


async def test_at_least_once_redelivery_after_consumer_crash(tmp_path):
    async with api(tmp_path) as (app, transport, http):
        await http.post("/topics", json={"name": "orders", "partitions": 1, "replication_factor": 1})
        p = Producer("http://mk", transport=transport)
        for i in range(10):
            await p.send("orders", f"m{i}")
        await p.flush()
        a = consumer(transport, "g")
        first = await a.poll()
        await a.commit({("orders", 0): first[4].offset + 1})       # processed 0..4, committed
        processed = [r.value for r in first]                        # ... but ALSO processed 5..9, then crashed
        a._hb_task.cancel()                                         # crash: no commit, no leave
        b = consumer(transport, "g")
        second = []
        while len(second) < 5:
            second += await b.poll(wait_ms=100)
        processed += [r.value for r in second]
        counts = Counter(processed)
        assert set(counts) == {f"m{i}" for i in range(10)}   # nothing lost
        assert [v for v, n in counts.items() if n == 2] == [f"m{i}" for i in range(5, 10)]   # 5..9 twice
        await b.close()
        await p.close()


async def test_replay_with_seek(tmp_path):
    async with api(tmp_path) as (app, transport, http):
        await http.post("/topics", json={"name": "orders", "partitions": 1, "replication_factor": 1})
        p = Producer("http://mk", transport=transport)
        for i in range(5):
            await p.send("orders", f"m{i}")
        await p.flush()
        c = consumer(transport, "g")
        assert len(await c.poll()) == 5 and await c.poll(wait_ms=20) == []
        c.seek(("orders", 0), 2)                                    # reprocess from offset 2
        assert [r.offset for r in await c.poll()] == [2, 3, 4]
        await c.close()
        await p.close()


async def test_idempotent_produce_over_http(tmp_path):
    async with api(tmp_path) as (app, transport, http):
        await http.post("/topics", json={"name": "orders", "partitions": 1, "replication_factor": 3})
        pid = (await http.post("/producers")).json()["producer_id"]
        body = {"records": [{"value": "a"}, {"value": "b"}], "partition": 0, "producer_id": pid, "base_sequence": 0}
        first = (await http.post("/topics/orders/produce", json=body)).json()
        retry = (await http.post("/topics/orders/produce", json=body)).json()
        assert retry["duplicate"] and retry["base_offset"] == first["base_offset"]
        assert (await http.get("/topics/orders/partitions/0/offsets")).json()["log_end_offset"] == 2
        gap = await http.post("/topics/orders/produce", json={**body, "base_sequence": 7})
        assert gap.status_code == 409 and gap.json()["error"]["code"] == "out_of_order_sequence_number"


async def test_error_mapping(tmp_path):
    async with api(tmp_path) as (app, transport, http):
        r = await http.post("/topics/nope/produce", json={"records": [{"value": "x"}]})
        assert r.status_code == 404
        await http.post("/topics", json={"name": "orders", "partitions": 1, "replication_factor": 3,
                                         "min_insync_replicas": 3})
        meta = (await http.get("/metadata")).json()["topics"]["orders"]["partitions"][0]
        follower = next(b for b in meta["replicas"] if b != meta["leader"])
        assert (await http.post(f"/admin/brokers/{follower}/kill")).status_code == 403   # needs token
        await http.post(f"/admin/brokers/{follower}/kill", headers=ADMIN)
        cluster = app.state.cluster
        assert await eventually(lambda: len(cluster.meta("orders", 0).isr) == 2)
        r = await http.post("/topics/orders/produce", json={"records": [{"value": "x"}], "acks": "all"})
        assert r.status_code == 503 and r.json()["error"] == {
            "code": "not_enough_replicas", "message": r.json()["error"]["message"], "retriable": True}


async def test_producer_survives_leader_failure(tmp_path):
    async with api(tmp_path) as (app, transport, http):
        await http.post("/topics", json={"name": "orders", "partitions": 1, "replication_factor": 3,
                                         "min_insync_replicas": 2})
        p = Producer("http://mk", transport=transport, retry_backoff_ms=50, retries=20)
        for i in range(20):
            await p.send_and_wait("orders", f"before{i}")
        leader = (await http.get("/metadata")).json()["topics"]["orders"]["partitions"][0]["leader"]
        await http.post(f"/admin/brokers/{leader}/kill", headers=ADMIN)
        for i in range(20):                       # first sends hit a dead leader -> retriable -> retry
            await p.send_and_wait("orders", f"after{i}")
        c = consumer(transport, "audit")
        got = []
        while len(got) < 40:
            got += await c.poll(wait_ms=100)
        assert [r.value for r in got] == [f"before{i}" for i in range(20)] + [f"after{i}" for i in range(20)]
        await c.close()
        await p.close()
