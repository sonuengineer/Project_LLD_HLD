"""Async load generator. Measures real latency and the allowed/denied split.

    python loadtest/load_test.py --url http://127.0.0.1:58001/api/resource --requests 5000 --concurrency 100

Prints numbers it actually measured; nothing is estimated.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import statistics
import time

import httpx


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--requests", type=int, default=2000)
    ap.add_argument("--concurrency", type=int, default=50)
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--distinct-ips", type=int, default=0,
                    help="send X-Real-IP from N fake IPs (only honoured if the app trusts it; direct-to-app test mode)")
    a = ap.parse_args()

    latencies: list[float] = []
    codes: collections.Counter[int] = collections.Counter()
    served_by: collections.Counter[str] = collections.Counter()
    queue: asyncio.Queue[int] = asyncio.Queue()
    for i in range(a.requests):
        queue.put_nowait(i)

    limits = httpx.Limits(max_connections=a.concurrency, max_keepalive_connections=a.concurrency)
    async with httpx.AsyncClient(limits=limits, timeout=10) as client:
        async def worker() -> None:
            while True:
                try:
                    i = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                headers = {}
                if a.api_key:
                    headers["X-API-Key"] = a.api_key
                if a.distinct_ips:
                    headers["X-Real-IP"] = f"10.0.{(i % a.distinct_ips) // 256}.{i % 256}"
                t = time.perf_counter()
                try:
                    r = await client.get(a.url, headers=headers)
                    codes[r.status_code] += 1
                    if r.status_code == 200 and "served_by" in r.text:
                        served_by[r.json().get("served_by", "?")] += 1
                except httpx.HTTPError as exc:
                    codes[type(exc).__name__] += 1
                latencies.append((time.perf_counter() - t) * 1000)

        start = time.perf_counter()
        await asyncio.gather(*[worker() for _ in range(a.concurrency)])
        elapsed = time.perf_counter() - start

    latencies.sort()
    pct = lambda p: latencies[min(int(len(latencies) * p), len(latencies) - 1)]
    print(f"requests={a.requests} concurrency={a.concurrency} elapsed={elapsed:.2f}s throughput={a.requests / elapsed:.0f} req/s")
    print(f"latency_ms p50={pct(0.50):.2f} p95={pct(0.95):.2f} p99={pct(0.99):.2f} max={latencies[-1]:.2f} mean={statistics.mean(latencies):.2f}")
    print(f"status_codes={dict(codes)}")
    if served_by:
        print(f"served_by={dict(served_by)}")


if __name__ == "__main__":
    asyncio.run(main())
