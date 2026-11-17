"""Regression tests for bugs found during the interview-bank code review (each was reproduced first)."""
import asyncio

import httpx
import pytest

from minikafka.cluster.errors import NotEnoughReplicasAfterAppend
from minikafka.storage.log import Log

from .conftest import eventually, msgs, running_cluster


async def test_offline_partition_recovers_when_last_isr_member_returns(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 1, 2)
        meta = c.meta("t", 0)
        follower = next(b for b in meta.replicas if b != meta.leader)
        await c.produce("t", 0, msgs(4), acks="all")
        await c.kill_broker(follower)
        assert await eventually(lambda: c.meta("t", 0).isr == {meta.leader})
        leader = meta.leader
        await c.kill_broker(leader)
        assert await eventually(lambda: c.meta("t", 0).leader is None)
        assert c.meta("t", 0).isr == {leader}           # last ISR member is remembered
        await c.restart_broker(leader)                   # it comes back ...
        assert await eventually(lambda: c.meta("t", 0).leader == leader, timeout=3)   # ... and leads again
        recs, hw, _ = await c.fetch("t", 0, 0)
        assert len(recs) == 4 and hw == 4                # committed data visible again


async def test_acks_all_fails_if_isr_shrinks_below_min_during_the_write(tmp_path):
    async with running_cluster(tmp_path, replica_lag_max_ms=200, request_timeout_ms=3000) as c:
        c.create_topic("t", 1, 3, min_insync_replicas=3)
        meta = c.meta("t", 0)
        stalled = next(b for b in meta.replicas if b != meta.leader)
        c.brokers[stalled].reachable = False
        c.brokers[stalled].last_heartbeat = 1e18          # alive for the controller, just not replicating
        with pytest.raises(NotEnoughReplicasAfterAppend):
            await c.produce("t", 0, msgs(1), acks="all")  # HW advances only because the ISR shrank


async def test_isr_shrink_wakes_waiting_producer_quickly(tmp_path):
    async with running_cluster(tmp_path, replica_lag_max_ms=200, request_timeout_ms=5000) as c:
        c.create_topic("t", 1, 3, min_insync_replicas=2)
        meta = c.meta("t", 0)
        stalled = next(b for b in meta.replicas if b != meta.leader)
        c.brokers[stalled].reachable = False
        c.brokers[stalled].last_heartbeat = 1e18
        t = asyncio.get_running_loop().time()
        await c.produce("t", 0, msgs(1), acks="all")      # completes once the ISR shrinks to {leader, other}
        assert asyncio.get_running_loop().time() - t < 2.0   # not the 5s request timeout


async def test_rf1_topic_data_visible_after_full_restart(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 1, 1)
        await c.produce("t", 0, msgs(5), acks=1)
    async with running_cluster(tmp_path) as c:
        assert c.offsets("t", 0)["high_watermark"] == 5
        recs, _, _ = await c.fetch("t", 0, 0)
        assert len(recs) == 5


def test_record_larger_than_max_bytes_is_still_returned(tmp_path):
    log = Log(tmp_path)
    log.append([(None, b"x" * 50_000)])
    log.append([(None, b"small")])
    recs = log.read(0, max_bytes=10)
    assert len(recs) == 1 and len(recs[0].value) == 50_000    # used to return [] forever
    assert log.read(1, max_bytes=10)[0].value == b"small"


async def test_producer_resets_identity_after_failed_batch(tmp_path):
    from minikafka.api.app import create_app
    from minikafka.client.producer import ProduceError, Producer
    from .conftest import fast_config
    app = create_app(fast_config(tmp_path), admin_token="t")
    async with app.router.lifespan_context(app):
        tr = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=tr, base_url="http://mk") as h:
            await h.post("/topics", json={"name": "t", "partitions": 1, "replication_factor": 1})
        p = Producer("http://mk", transport=tr, retries=0)
        await p.send_and_wait("t", "ok-1")
        first_pid = p.producer_id
        cluster = app.state.cluster
        real = cluster.produce

        async def fail_once(*a, **k):
            from minikafka.cluster.errors import LeaderNotAvailable
            cluster.produce = real
            raise LeaderNotAvailable("simulated")
        cluster.produce = fail_once
        with pytest.raises(ProduceError):
            await p.send_and_wait("t", "lost")
        await p.send_and_wait("t", "ok-2")                       # used to fail: out_of_order_sequence
        assert p.producer_id != first_pid
        await p.close()
