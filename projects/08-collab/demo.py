"""Two simulated users editing one document through the load balancer (likely on different servers).
    python demo.py http://127.0.0.1:58008"""
import asyncio
import sys

import httpx

from collab.client import CollabClient

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8008"
WS = BASE.replace("http", "ws") + "/ws"


async def main():
    async with httpx.AsyncClient(base_url=BASE) as h:
        alice = (await h.post("/users", json={"name": "alice"})).json()
        bob = (await h.post("/users", json={"name": "bob"})).json()
        doc = (await h.post("/docs", json={"title": "Meeting notes", "content": "Agenda:\n"},
                            headers={"Authorization": f"Bearer {alice['token']}"})).json()
        await h.post(f"/docs/{doc['id']}/share", json={"user_id": bob["user_id"], "role": "editor"},
                     headers={"Authorization": f"Bearer {alice['token']}"})

        def tickets(u):
            async def t():
                return (await h.post("/ws-tickets", headers={"Authorization": f"Bearer {u['token']}"})).json()["ticket"]
            return t
        a, b = CollabClient(WS, doc["id"], tickets(alice)), CollabClient(WS, doc["id"], tickets(bob))
        await a.connect()
        await b.connect()
        await asyncio.gather(a.insert(len(a.doc), "1. budget (alice)\n"), b.insert(len(b.doc), "2. hiring (bob)\n"))
        for _ in range(200):
            if a.settled and b.settled and a.doc == b.doc:
                break
            await asyncio.sleep(0.05)
        print("alice sees:\n" + a.doc)
        print("converged:", a.doc == b.doc, "rev:", a.rev)
        for path in ("/stats",) * 4:
            print("lb ->", (await h.get(path)).json()["server_id"])
        await a.disconnect()
        await b.disconnect()


asyncio.run(main())
