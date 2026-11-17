"""End-to-end demo against a running server: python demo.py [base_url] [admin_token]
Creates a topic, produces keyed orders, kills the partition leader mid-stream, keeps producing,
then consumes everything with a consumer group and prints the lag."""
import asyncio
import sys

import httpx

from minikafka.client.consumer import Consumer
from minikafka.client.producer import Producer

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8005"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "change-me-mk-token"


async def main():
    async with httpx.AsyncClient(base_url=BASE) as h:
        r = await h.post("/topics", json={"name": "orders", "partitions": 3, "replication_factor": 3,
                                          "min_insync_replicas": 2})
        print("create topic:", r.status_code, r.json())
        p = Producer(BASE, retries=30, retry_backoff_ms=100)
        for i in range(30):
            await p.send("orders", f"order-{i}", key=f"customer-{i % 5}")
        await p.flush()
        leader = (await h.get("/metadata")).json()["topics"]["orders"]["partitions"][0]["leader"]
        print(f"killing broker {leader} (leader of orders-0)")
        await h.post(f"/admin/brokers/{leader}/kill", headers={"X-Admin-Token": TOKEN})
        for i in range(30, 60):
            await p.send("orders", f"order-{i}", key=f"customer-{i % 5}")
        await p.flush()
        await p.close()
        part0 = (await h.get("/metadata")).json()["topics"]["orders"]["partitions"][0]
        print(f"orders-0 now: leader={part0['leader']} isr={part0['isr']} epoch={part0['leader_epoch']}")
        c = Consumer("demo-group", ["orders"], BASE)
        got = []
        while len(got) < 60:
            got += await c.poll(wait_ms=200)
            await c.commit()
        print(f"consumed {len(got)} records, unique values: {len({r.value for r in got})}")
        print("lag:", (await h.get("/groups/demo-group")).json()["lag"])
        await c.close()
        await h.post(f"/admin/brokers/{leader}/restart", headers={"X-Admin-Token": TOKEN})
        print("restarted broker", leader, "-> see /dashboard for ISR recovery")


asyncio.run(main())
