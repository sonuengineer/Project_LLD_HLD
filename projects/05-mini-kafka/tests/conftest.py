import asyncio
import contextlib

import pytest

from minikafka.cluster.cluster import Cluster
from minikafka.cluster.config import ClusterConfig


def fast_config(tmp_path, **kw) -> ClusterConfig:
    base = dict(data_dir=tmp_path, brokers=3, replica_fetch_wait_ms=10, replica_lag_max_ms=400,
                broker_heartbeat_interval_ms=20, broker_session_timeout_ms=150, request_timeout_ms=1500,
                retention_check_interval_ms=100, group_rebalance_delay_ms=100, group_min_session_timeout_ms=100)
    base.update(kw)
    return ClusterConfig(**base)


@contextlib.asynccontextmanager
async def running_cluster(tmp_path, **kw):
    c = Cluster(fast_config(tmp_path, **kw))
    await c.start()
    try:
        yield c
    finally:
        await c.stop()


@pytest.fixture
async def cluster(tmp_path):
    async with running_cluster(tmp_path) as c:
        yield c


async def eventually(pred, timeout=3.0, interval=0.02):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(interval)
    return False


def msgs(n, prefix="m"):
    return [(None, f"{prefix}{i}".encode()) for i in range(n)]
