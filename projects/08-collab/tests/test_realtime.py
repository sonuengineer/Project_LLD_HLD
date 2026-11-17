"""Real servers (uvicorn), real WebSockets, real Postgres + Redis. Two server instances = horizontal scaling."""
import asyncio
import json
import random

import pytest
import websockets

from collab.client import CollabClient
from collab.ot import TextOp

from .conftest import Api, run_server


async def until(pred, timeout=10.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(0.02)
    return False


async def server_content(api, u, doc_id):
    return (await api.http.get(f"/docs/{doc_id}", headers=api.h(u))).json()


async def test_two_users_edit_concurrently_and_converge(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        alice, bob = await api.user("alice"), await api.user("bob")
        doc = (await api.http.post("/docs", json={"title": "Plan", "content": "hello world"}, headers=api.h(alice))).json()
        await api.http.post(f"/docs/{doc['id']}/share", json={"user_id": bob["user_id"], "role": "editor"}, headers=api.h(alice))
        a = CollabClient(ws, doc["id"], api.ticket_factory(alice))
        b = CollabClient(ws, doc["id"], api.ticket_factory(bob))
        await a.connect()
        await b.connect()
        # Concurrent: both edit the SAME original text before seeing each other's change.
        await asyncio.gather(a.insert(0, "Alice: "), b.insert(11, "!!!"))
        await asyncio.gather(a.delete(7, 5), b.insert(5, ","))   # alice deletes "hello"
        assert await until(lambda: a.settled and b.settled and a.rev == b.rev == 4 and a.doc == b.doc)
        final = await server_content(api, alice, doc["id"])
        assert a.doc == b.doc == final["content"]
        assert final["content"] == "Alice: , world!!!"


async def test_horizontal_scaling_two_servers(clean):
    async with run_server("s1") as (_, base1, ws1), run_server("s2") as (_, base2, ws2):
        api = Api(base1)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D"}, headers=api.h(u))).json()
        c1 = CollabClient(ws1, doc["id"], api.ticket_factory(u))
        c2 = CollabClient(ws2, doc["id"], api.ticket_factory(u))
        await c1.connect()
        await c2.connect()
        await c1.insert(0, "from server one. ")
        assert await until(lambda: c2.doc == "from server one. ")
        await c2.insert(len(c2.doc), "from server two.")
        assert await until(lambda: c1.doc == c2.doc == "from server one. from server two.")


@pytest.mark.parametrize("seed", [1, 2])
async def test_fuzz_many_clients_two_servers_with_disconnects(clean, seed):
    """6 clients on 2 servers make random concurrent edits; 2 of them go offline mid-way, keep editing,
    and reconnect. Everyone must converge to the server's document."""
    rng = random.Random(seed)
    async with run_server("s1") as (_, base1, ws1), run_server("s2") as (_, base2, ws2):
        api = Api(base1)
        u = await api.user("fuzzer")
        doc = (await api.http.post("/docs", json={"title": "F", "content": "start"}, headers=api.h(u))).json()
        clients = [CollabClient(ws1 if i % 2 == 0 else ws2, doc["id"], api.ticket_factory(u)) for i in range(6)]
        for c in clients:
            await c.connect()

        async def actor(i, c):
            for step in range(25):
                if i < 2 and step == 8:
                    await c.disconnect()                       # go offline
                if i < 2 and step == 16:
                    await c.connect()                          # come back: catch up + resend
                n = len(c.doc)
                if n and rng.random() < 0.4:
                    pos = rng.randrange(n)
                    await c.delete(pos, min(rng.randint(1, 3), n - pos))
                else:
                    await c.insert(rng.randint(0, n), rng.choice(["a", "bb", "ccc", " ", "Z"]))
                await asyncio.sleep(rng.random() * 0.02)

        await asyncio.gather(*[actor(i, c) for i, c in enumerate(clients)])
        assert await until(lambda: all(c.settled for c in clients), timeout=20)
        final = await server_content(api, u, doc["id"])
        assert await until(lambda: all(c.rev == final["rev"] for c in clients), timeout=20)
        assert all(c.doc == final["content"] for c in clients), [c.doc for c in clients]
        assert all(not c.errors for c in clients)
        for c in clients:
            await c.disconnect()


async def test_lost_ack_resend_is_deduplicated(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "abc"}, headers=api.h(u))).json()
        c = CollabClient(ws, doc["id"], api.ticket_factory(u))
        await c.connect()
        # Send an op, then drop the connection before the ack can be processed.
        c._reader.cancel()
        await c.insert(3, "XYZ")
        await asyncio.sleep(0.3)                     # server applied it (rev 1); ack never read
        await c.disconnect()
        assert c.outstanding is not None             # client still thinks it is unacked
        await c.connect()                            # catch-up delivers rev 1 as OUR ack; resend would be deduped
        assert await until(lambda: c.settled)
        final = await server_content(api, u, doc["id"])
        assert final["content"] == c.doc == "abcXYZ" and final["rev"] == 1   # applied exactly once


async def test_offline_edits_sync_after_reconnect(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "shared"}, headers=api.h(u))).json()
        online, offline = CollabClient(ws, doc["id"], api.ticket_factory(u)), CollabClient(ws, doc["id"], api.ticket_factory(u))
        await online.connect()
        await offline.connect()
        await offline.disconnect()
        await offline.insert(0, "[draft] ")          # edited on a plane
        await offline.insert(len(offline.doc), " (v2)")
        for _ in range(5):
            await online.insert(len(online.doc), ".")  # meanwhile others keep editing
        await offline.connect()
        assert await until(lambda: offline.settled and online.doc == offline.doc and online.settled)
        assert offline.doc == "[draft] shared (v2)....." or offline.doc == "[draft] shared..... (v2)"


async def test_viewer_cannot_edit_and_strangers_cannot_join(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        owner, viewer, stranger = await api.user("o"), await api.user("v"), await api.user("s")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "x"}, headers=api.h(owner))).json()
        await api.http.post(f"/docs/{doc['id']}/share", json={"user_id": viewer["user_id"], "role": "viewer"},
                            headers=api.h(owner))
        v = CollabClient(ws, doc["id"], api.ticket_factory(viewer))
        await v.connect()
        await v.insert(0, "hack")
        assert await until(lambda: v.errors and v.errors[0]["code"] == "forbidden")
        assert (await server_content(api, owner, doc["id"]))["content"] == "x"
        s = CollabClient(ws, doc["id"], api.ticket_factory(stranger))
        with pytest.raises(Exception):
            await s.connect()


async def test_ws_ticket_is_single_use(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        ticket = await api.ticket_factory(u)()
        async with websockets.connect(f"{ws}?ticket={ticket}") as conn:
            await conn.send(json.dumps({"type": "join", "doc_id": "00000000-0000-0000-0000-000000000000", "client_id": "x"}))
            await conn.recv()
        with pytest.raises(Exception):
            async with websockets.connect(f"{ws}?ticket={ticket}") as conn:
                await conn.recv()


async def test_presence_and_cursors(clean):
    async with run_server("s1") as (app, base, ws), run_server("s2") as (_, base2, ws2):
        api = Api(base)
        a_user, b_user = await api.user("alice"), await api.user("bob")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "hi"}, headers=api.h(a_user))).json()
        await api.http.post(f"/docs/{doc['id']}/share", json={"user_id": b_user["user_id"], "role": "editor"},
                            headers=api.h(a_user))
        a = CollabClient(ws, doc["id"], api.ticket_factory(a_user))
        await a.connect()
        b = CollabClient(ws2, doc["id"], api.ticket_factory(b_user))
        await b.connect()
        assert await until(lambda: any(e["event"] == "join" and e["name"] == "bob" for e in a.presence_events))
        await b.send_cursor(1)
        pres = (await api.http.get(f"/docs/{doc['id']}/presence", headers=api.h(a_user))).json()["presence"]
        assert await until(lambda: True)
        names = sorted(p["name"] for p in pres)
        assert names == ["alice", "bob"]
        await b.disconnect()
        assert await until(lambda: any(e["event"] == "leave" for e in a.presence_events))


async def test_history_revision_and_restore(clean):
    async with run_server("s1", snapshot_every=3) as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D", "content": ""}, headers=api.h(u))).json()
        c = CollabClient(ws, doc["id"], api.ticket_factory(u))
        await c.connect()
        for word in ["one ", "two ", "three ", "four ", "five"]:
            await c.insert(len(c.doc), word)
            assert await until(lambda: c.settled)
        r2 = (await api.http.get(f"/docs/{doc['id']}/revisions/2", headers=api.h(u))).json()
        r4 = (await api.http.get(f"/docs/{doc['id']}/revisions/4", headers=api.h(u))).json()
        assert r2["content"] == "one two " and r4["content"] == "one two three four "   # r4 via snapshot@3 + replay
        hist = (await api.http.get(f"/docs/{doc['id']}/history", headers=api.h(u))).json()["history"]
        assert [h["rev"] for h in hist] == [5, 4, 3, 2, 1] and hist[0]["chars_inserted"] == 4
        await api.http.post(f"/docs/{doc['id']}/restore/2", headers=api.h(u))
        assert await until(lambda: c.doc == "one two ")             # live client sees the restore
        assert (await server_content(api, u, doc["id"]))["rev"] == 6  # restore is a new revision


async def test_invalid_operation_rejected(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "abc"}, headers=api.h(u))).json()
        c = CollabClient(ws, doc["id"], api.ticket_factory(u))
        await c.connect()
        await c.ws.send(json.dumps({"type": "op", "client_seq": 99, "base_rev": 0, "op": [10, "x"]}))   # wrong length
        assert await until(lambda: c.errors)
        assert c.errors[0]["code"] == "invalid_operation"
        assert (await server_content(api, u, doc["id"]))["rev"] == 0


async def test_lost_last_message_is_recovered_by_tail_check(clean):
    """Pub/sub dropped the LAST op of a burst: no later revision reveals the gap, so only the tail check
    can deliver it -- including the author's own ack (otherwise the author's sync would stop forever)."""
    async with run_server("s1", tail_check_ms=200) as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "abc"}, headers=api.h(u))).json()
        author, reader = CollabClient(ws, doc["id"], api.ticket_factory(u)), CollabClient(ws, doc["id"], api.ticket_factory(u))
        await author.connect()
        await reader.connect()
        hub = app.state.hub
        real_publish = hub.publish

        async def lossy_publish(doc_id, msg):
            if msg.get("type") != "op":            # simulate pub/sub losing every op message
                await real_publish(doc_id, msg)
        hub.publish = lossy_publish
        await author.insert(3, "!")
        assert await until(lambda: author.settled and reader.doc == "abc!", timeout=5)
        assert hub.stats["tail_fills"] >= 1


async def test_client_id_of_another_user_cannot_be_hijacked(clean):
    async with run_server("s1") as (app, base, ws):
        api = Api(base)
        alice, mallory = await api.user("alice"), await api.user("mallory")
        doc = (await api.http.post("/docs", json={"title": "D", "content": ""}, headers=api.h(alice))).json()
        await api.http.post(f"/docs/{doc['id']}/share", json={"user_id": mallory["user_id"], "role": "editor"},
                            headers=api.h(alice))
        a = CollabClient(ws, doc["id"], api.ticket_factory(alice), client_id="shared-id")
        m = CollabClient(ws, doc["id"], api.ticket_factory(mallory), client_id="shared-id")   # copied from op messages
        await a.connect()
        await m.connect()
        await m.insert(0, "M")                       # seq 1 under the same raw client_id
        assert await until(lambda: m.settled)
        await a.insert(len(a.doc), "A")              # seq 1 too: must NOT be treated as a duplicate of Mallory's op
        assert await until(lambda: a.settled and m.settled and a.doc == m.doc)
        final = await server_content(api, alice, doc["id"])
        assert final["rev"] == 2 and final["content"] == "MA"


async def test_revoking_access_closes_sockets_and_sequencer_rejects(clean):
    from collab import service
    async with run_server("s1") as (app, base, ws), run_server("s2") as (_, base2, ws2):
        api = Api(base)
        owner, bob = await api.user("o"), await api.user("b")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "x"}, headers=api.h(owner))).json()
        share = f"/docs/{doc['id']}/share"
        await api.http.post(share, json={"user_id": bob["user_id"], "role": "editor"}, headers=api.h(owner))
        # owner can neither demote itself nor be revoked
        r = await api.http.post(share, json={"user_id": owner["user_id"], "role": "viewer"}, headers=api.h(owner))
        assert r.status_code == 409
        assert (await api.http.delete(f"{share}/{owner['user_id']}", headers=api.h(owner))).status_code == 409
        b = CollabClient(ws2, doc["id"], api.ticket_factory(bob))   # bob is on the OTHER server
        await b.connect()
        # downgrade -> bob's open socket becomes read-only immediately
        await api.http.post(share, json={"user_id": bob["user_id"], "role": "viewer"}, headers=api.h(owner))
        await asyncio.sleep(0.3)
        await b.insert(0, "no")
        assert await until(lambda: any(e["code"] == "forbidden" for e in b.errors))
        # revoke -> socket closed by the server
        assert (await api.http.delete(f"{share}/{bob['user_id']}", headers=api.h(owner))).status_code == 200
        assert await until(lambda: any(e["code"] == "access_revoked" for e in b.errors) and not b.connected)
        assert (await api.http.get(f"/docs/{doc['id']}", headers=api.h(bob))).status_code == 404
        # even if the pub/sub event had been lost, the sequencer refuses the write
        with pytest.raises(Exception) as ei:
            await service.submit(app.state.sm, app.state.settings, doc["id"], bob["user_id"], "b:x", 1, 0, ["y", 1])
        assert getattr(ei.value, "code", "") == "forbidden"
        assert (await server_content(api, owner, doc["id"]))["content"] == "x"


async def test_rejected_op_makes_client_resync_instead_of_stalling(clean):
    async with run_server("s1", max_document_chars=20) as (app, base, ws):
        api = Api(base)
        u = await api.user("u")
        doc = (await api.http.post("/docs", json={"title": "D", "content": "short"}, headers=api.h(u))).json()
        c = CollabClient(ws, doc["id"], api.ticket_factory(u))
        await c.connect()
        await c.insert(5, " way too long for the limit")     # server rejects: document too large
        await c.insert(0, ">")                               # buffered on top of the rejected op
        assert await until(lambda: c.resyncs == 1 and c.settled and c.doc == "short", timeout=5)
        await c.insert(5, "!")                               # and the client keeps working afterwards
        assert await until(lambda: c.settled)
        assert (await server_content(api, u, doc["id"]))["content"] == "short!"
