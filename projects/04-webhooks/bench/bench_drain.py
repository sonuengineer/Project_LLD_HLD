"""Honest delivery throughput: build a backlog with dispatchers STOPPED, then start them and time
the drain. Usage (stack running): python bench_drain.py <n_events> <replicas>"""
import asyncio
import subprocess
import sys
import time

import httpx

API, RCV = "http://127.0.0.1:58004", "http://127.0.0.1:58014"
H = {"Authorization": "Bearer change-me-wh-token"}
n, replicas = int(sys.argv[1]), int(sys.argv[2])


def fresh_stack() -> None:
    """Every run starts from an empty database so old endpoints/retries can't distort the result."""
    subprocess.run(["docker", "compose", "down", "-v"], capture_output=True)
    subprocess.run(["docker", "compose", "up", "-d", "--scale", "dispatcher=0"], capture_output=True)
    for _ in range(120):
        try:
            if httpx.get(f"{API}/healthz").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise SystemExit("api did not come up")


async def main():
    fresh_stack()
    async with httpx.AsyncClient(headers=H, timeout=60) as c:
        ep = (await c.post(f"{API}/endpoints", json={"url": "http://receiver:9000/webhook",
                                                     "rate_limit_per_second": 1000})).json()
        await c.post(f"{RCV}/admin/config", json={"secrets": [ep["secret"]], "fail_next": 0})
        sem = asyncio.Semaphore(20)

        async def pub(i):
            async with sem:
                (await c.post(f"{API}/events", json={"type": "bench.tick", "payload": {"i": i}})).raise_for_status()
        await asyncio.gather(*[pub(i) for i in range(n)])
        base = (await c.get(f"{API}/stats")).json()["deliveries"].get("succeeded", 0)
        pending = (await c.get(f"{API}/stats")).json()["deliveries"].get("pending", 0)
        print(f"backlog: {pending} pending deliveries", flush=True)
        subprocess.run(["docker", "compose", "up", "-d", "--scale", f"dispatcher={replicas}", "dispatcher"],
                       capture_output=True)
        t0 = time.time()
        while True:
            st = (await c.get(f"{API}/stats")).json()["deliveries"]
            if st.get("pending", 0) == 0 and st.get("in_flight", 0) == 0:
                break
            if time.time() - t0 > 240:
                print("TIMEOUT", st, flush=True)
                break
            await asyncio.sleep(0.1)
        el = time.time() - t0
        done = st.get("succeeded", 0) - base
        print(f"{replicas} dispatcher(s): drained {done} deliveries in {el:.2f}s -> {done / el:.0f} deliveries/s "
              f"(includes container start-up); stats={st}", flush=True)
        rc = (await c.get(f"{RCV}/admin/received")).json()
        print(f"receiver verified {rc['count']} unique, duplicates={rc['duplicates']}", flush=True)


asyncio.run(main())
