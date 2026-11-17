"""Throughput benchmarks at three layers. python bench/bench.py
All numbers are printed from real measurements on the current machine."""
import asyncio
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx  # noqa: E402

from minikafka.api.app import create_app  # noqa: E402
from minikafka.client.producer import Producer  # noqa: E402
from minikafka.cluster.cluster import Cluster  # noqa: E402
from minikafka.cluster.config import ClusterConfig  # noqa: E402
from minikafka.storage.log import Log  # noqa: E402

VALUE = b"x" * 100


def storage(n=200_000):
    print("== storage: Log.append (100-byte values)")
    for batch, fsync in [(1, False), (100, False), (1000, False), (100, True)]:
        if fsync and batch == 100:
            n_run = 20_000
        else:
            n_run = n if batch > 1 else 50_000
        log = Log(Path(tempfile.mkdtemp()), segment_bytes=64 * 1024 * 1024, fsync_every_append=fsync)
        items = [(None, VALUE)] * batch
        t = time.perf_counter()
        for _ in range(n_run // batch):
            log.append(items)
        el = time.perf_counter() - t
        print(f"  batch={batch:<5} fsync={str(fsync):<5} {n_run / el:>10,.0f} msg/s  {n_run * 128 / el / 1e6:6.1f} MB/s")
        t = time.perf_counter()
        off, read = 0, 0
        while off < log.log_end_offset:
            recs = log.read(off, 1024 * 1024)
            read += len(recs)
            off = recs[-1].offset + 1
        el = time.perf_counter() - t
        if batch == 1000:
            print(f"  sequential read             {read / el:>10,.0f} msg/s")
        log.close()


async def cluster(n=20_000, batch=100):
    print("== cluster (in-process, rf=3, 3 brokers): produce")
    for acks in (1, "all"):
        c = Cluster(ClusterConfig(data_dir=Path(tempfile.mkdtemp()), brokers=3, replica_fetch_wait_ms=5))
        await c.start()
        c.create_topic("t", 1, 3, min_insync_replicas=2)
        items = [(None, VALUE)] * batch
        t = time.perf_counter()
        for _ in range(n // batch):
            await c.produce("t", 0, items, acks=acks)
        el = time.perf_counter() - t
        print(f"  acks={acks!s:<4} batch={batch}  {n / el:>10,.0f} msg/s  (sequential requests)")
        await c.stop()
    # acks=all latency is one replication round trip; concurrency (many partitions / in-flight
    # requests) hides it. 8 partitions, one producer task per partition.
    c = Cluster(ClusterConfig(data_dir=Path(tempfile.mkdtemp()), brokers=3, replica_fetch_wait_ms=5))
    await c.start()
    c.create_topic("p8", 8, 3, min_insync_replicas=2)
    items = [(None, VALUE)] * batch
    lat = []

    async def worker(part):
        for _ in range(n // batch // 8):
            t0 = time.perf_counter()
            await c.produce("p8", part, items, acks="all")
            lat.append(time.perf_counter() - t0)

    t = time.perf_counter()
    await asyncio.gather(*[worker(i) for i in range(8)])
    el = time.perf_counter() - t
    lat.sort()
    print(f"  acks=all batch={batch}  {n / el:>10,.0f} msg/s  (8 partitions concurrently; "
          f"request p50={lat[len(lat) // 2] * 1000:.1f}ms p99={lat[int(len(lat) * .99)] * 1000:.1f}ms)")
    await c.stop()


async def http_producer(n=10_000):
    print("== HTTP producer client -> API (ASGI in-process), acks=all, rf=3")
    for batch_size, linger in [(1, 0), (100, 5), (1000, 10)]:
        app = create_app(ClusterConfig(data_dir=Path(tempfile.mkdtemp()), brokers=3, replica_fetch_wait_ms=5))
        async with app.router.lifespan_context(app):
            tr = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=tr, base_url="http://mk") as h:
                await h.post("/topics", json={"name": "t", "partitions": 4, "replication_factor": 3})
            p = Producer("http://mk", transport=tr, batch_size=batch_size, linger_ms=linger)
            count = n if batch_size > 1 else 2000
            t = time.perf_counter()
            futs = [await p.send("t", "x" * 100, key=str(i)) for i in range(count)]
            await p.flush()
            await asyncio.gather(*futs)
            el = time.perf_counter() - t
            print(f"  batch_size={batch_size:<5} linger={linger}ms  {count / el:>10,.0f} msg/s")
            await p.close()


if __name__ == "__main__":
    which = sys.argv[1:] or ["storage", "cluster", "http"]
    if "storage" in which:
        storage()
    if "cluster" in which:
        asyncio.run(cluster())
    if "http" in which:
        asyncio.run(http_producer())
