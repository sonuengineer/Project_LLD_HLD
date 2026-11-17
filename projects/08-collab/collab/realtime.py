"""WebSocket fan-out across many server instances.

Each server keeps local "rooms" (document -> connections on THIS server). Every committed operation is
published to Redis channel collab:doc:{id}; every server subscribes and forwards to its local rooms.

Two properties of Redis pub/sub we must handle (both bite real systems):
  1. Ordering across publishers is not guaranteed: server A commits rev 5, server B commits rev 6, B's
     message can arrive first.
  2. Delivery is at-most-once: a subscriber that blips can miss a message entirely.
So each room has an ORDERED FORWARDER: it delivers revisions strictly in sequence, buffers early arrivals,
and if a gap persists for gap_fill_delay_ms it reads the missing revisions from Postgres (the source of
truth). Acks travel the same ordered stream: the author's connection receives its own op as an "ack" at
its revision, so a client never sees its ack before an earlier concurrent op.

A gap is only noticed when a LATER revision arrives. If the last message of a burst is lost there is no
later one, so the room would stay stale (and an author would never get its ack). The tail check closes that
hole: every tail_check_ms each server compares its rooms with the DB head and fills anything missing.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

from redis.asyncio import Redis

from . import service

log = logging.getLogger(__name__)
CHANNEL = "collab:doc:{}"


@dataclass(eq=False)
class Conn:
    ws: object
    user_id: str
    user_name: str
    client_id: str
    role: str
    doc_id: str = ""
    conn_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    base_rev: int = 0                       # highest revision this connection has been given
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1000))
    closed: bool = False
    on_kick: Callable[[int, str], None] | None = None   # set by the endpoint: closes the socket now

    def send(self, msg: dict) -> bool:
        """Non-blocking enqueue. A full queue = the client can't keep up: drop it (it will reconnect and
        catch up from its last revision) instead of letting one slow client block the room."""
        try:
            self.queue.put_nowait(msg)
            return True
        except asyncio.QueueFull:
            self.kick(1013, "client too slow; reconnect and catch up")
            return False

    def kick(self, code: int, reason: str) -> None:
        """Close the connection immediately (not when the client next sends something)."""
        if self.closed:
            return
        self.closed = True
        if self.on_kick:
            self.on_kick(code, reason)


@dataclass
class Room:
    doc_id: str
    conns: dict[str, Conn] = field(default_factory=dict)
    next_rev: int = 1
    buffer: dict[int, dict] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    gap_task: asyncio.Task | None = None


class Hub:
    def __init__(self, sm, redis: Redis, settings):
        self.sm, self.redis, self.cfg = sm, redis, settings
        self.rooms: dict[str, Room] = {}
        self._sub_task: asyncio.Task | None = None
        self._tail_task: asyncio.Task | None = None
        self.stats = {"published": 0, "received": 0, "gap_fills": 0, "tail_fills": 0, "duplicates_ignored": 0,
                      "slow_disconnects": 0, "kicked": 0}

    # ---- lifecycle ----------------------------------------------------------------------------------
    async def start(self) -> None:
        self._sub_task = asyncio.create_task(self._subscriber())
        self._tail_task = asyncio.create_task(self._tail_loop())

    async def stop(self) -> None:
        for t in (self._sub_task, self._tail_task):
            if t:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t

    async def _subscriber(self) -> None:
        while True:
            pubsub = self.redis.pubsub()
            try:
                await pubsub.psubscribe(CHANNEL.format("*"))
                async for m in pubsub.listen():
                    if m["type"] != "pmessage":
                        continue
                    self.stats["received"] += 1
                    try:
                        await self._on_message(json.loads(m["data"]))
                    except Exception:
                        log.exception("pubsub_message_failed")
            except asyncio.CancelledError:
                with contextlib.suppress(Exception):
                    await pubsub.aclose()
                raise
            except Exception:
                # Lost the subscription (Redis restart). Messages published meanwhile are LOST -- the ordered
                # forwarder's gap fill recovers them from Postgres on the next revision that arrives.
                log.exception("pubsub_disconnected")
                await asyncio.sleep(0.5)

    async def publish(self, doc_id: str, msg: dict) -> None:
        self.stats["published"] += 1
        await self.redis.publish(CHANNEL.format(doc_id), json.dumps({**msg, "doc_id": doc_id,
                                                                      "server": self.cfg.server_id}))

    # ---- membership ---------------------------------------------------------------------------------
    async def join(self, conn: Conn, doc_id: str, last_rev: int | None) -> None:
        conn.doc_id = doc_id
        while True:
            room = self.rooms.setdefault(doc_id, Room(doc_id))
            await room.lock.acquire()
            if self.rooms.get(doc_id) is room:
                break
            room.lock.release()   # a concurrent leave() removed this room meanwhile: use the new one
        try:
            snap = await service.snapshot(self.sm, doc_id)
            head = snap["rev"]
            if not room.conns:
                # First local connection: start the ordered stream right after what we just read.
                room.next_rev = head + 1
                room.buffer = {r: m for r, m in room.buffer.items() if r > head}
            if last_rev is not None and 0 <= last_rev <= head:
                # Reconnect: send only what the client missed (keeps its pending local edits valid).
                for o in await service.ops_between(self.sm, doc_id, last_rev, head):
                    conn.send(self._for(conn, {**o, "type": "op"}))
                conn.send({"type": "joined", "rev": head, "catchup": True, "conn_id": conn.conn_id,
                           "presence": await self.presence(doc_id)})
            else:
                conn.send({"type": "joined", "rev": head, "content": snap["content"], "title": snap["title"],
                           "catchup": False, "conn_id": conn.conn_id, "presence": await self.presence(doc_id)})
            conn.base_rev = head
            room.conns[conn.conn_id] = conn
        finally:
            room.lock.release()
        await self.redis.hset(f"collab:presence:{doc_id}", conn.conn_id, json.dumps(
            {"user_id": conn.user_id, "name": conn.user_name, "client_id": conn.client_id, "ts": time.time(),
             "cursor": None, "server": self.cfg.server_id}))
        await self.publish(doc_id, {"type": "presence", "event": "join", "conn_id": conn.conn_id,
                                    "user_id": conn.user_id, "name": conn.user_name})

    async def leave(self, conn: Conn) -> None:
        room = self.rooms.get(conn.doc_id)
        if room is None:
            return
        async with room.lock:   # same lock as join(): a joiner can't be registered into a room being dropped
            room.conns.pop(conn.conn_id, None)
            if not room.conns and self.rooms.get(conn.doc_id) is room:
                self.rooms.pop(conn.doc_id, None)
                if room.gap_task:
                    room.gap_task.cancel()
        with contextlib.suppress(Exception):
            await self.redis.hdel(f"collab:presence:{conn.doc_id}", conn.conn_id)
            await self.publish(conn.doc_id, {"type": "presence", "event": "leave", "conn_id": conn.conn_id,
                                             "user_id": conn.user_id, "name": conn.user_name})

    async def presence(self, doc_id: str) -> list[dict]:
        raw = await self.redis.hgetall(f"collab:presence:{doc_id}")
        now, out = time.time(), []
        for cid, v in raw.items():
            d = json.loads(v)
            if now - d["ts"] <= self.cfg.presence_stale_seconds:   # entries of crashed servers age out
                out.append({"conn_id": cid.decode() if isinstance(cid, bytes) else cid, **d})
        return out

    async def touch(self, conn: Conn, cursor: dict | None = None) -> None:
        key = f"collab:presence:{conn.doc_id}"
        raw = await self.redis.hget(key, conn.conn_id)
        d = json.loads(raw) if raw else {"user_id": conn.user_id, "name": conn.user_name, "client_id": conn.client_id}
        d["ts"] = time.time()
        if cursor is not None:
            d["cursor"] = cursor
        await self.redis.hset(key, conn.conn_id, json.dumps(d))

    # ---- fan-out ------------------------------------------------------------------------------------
    def _for(self, conn: Conn, m: dict) -> dict:
        if m.get("client_id") == conn.client_id:
            return {"type": "ack", "rev": m["rev"], "client_seq": m.get("client_seq")}
        return {"type": "op", "rev": m["rev"], "op": m["op"], "user_id": m.get("user_id"), "client_id": m.get("client_id")}

    async def _on_message(self, m: dict) -> None:
        room = self.rooms.get(m.get("doc_id"))
        if room is None:
            return
        if m["type"] == "op":
            await self._deliver_ordered(room, m)
        elif m["type"] == "perm":
            self._apply_permission(room, m["user_id"], m.get("role"))
        elif m["type"] in ("presence", "cursor"):
            for c in list(room.conns.values()):
                if c.conn_id != m.get("conn_id"):
                    c.send({k: v for k, v in m.items() if k not in ("server",)})

    async def _deliver_ordered(self, room: Room, m: dict) -> None:
        async with room.lock:
            rev = m["rev"]
            if rev < room.next_rev or rev in room.buffer:
                self.stats["duplicates_ignored"] += 1
                return
            room.buffer[rev] = m
            self._flush(room)
            if room.buffer and (room.gap_task is None or room.gap_task.done()):
                room.gap_task = asyncio.create_task(self._fill_gap_later(room))

    def _flush(self, room: Room) -> None:
        while room.next_rev in room.buffer:
            m = room.buffer.pop(room.next_rev)
            for c in list(room.conns.values()):
                if m["rev"] > c.base_rev:
                    if c.send(self._for(c, m)):
                        c.base_rev = m["rev"]
                    else:
                        self.stats["slow_disconnects"] += 1
            room.next_rev += 1

    def _apply_permission(self, room: Room, user_id: str, role: str | None) -> None:
        """Share changed: update open connections of that user (role None = access revoked -> disconnect).
        Best effort only -- service.submit re-checks the role for every op, so a lost event cannot let a
        revoked user write; it only means their socket stays open (read-only in effect) a little longer."""
        for c in list(room.conns.values()):
            if c.user_id != user_id:
                continue
            if role is None:
                c.send({"type": "error", "code": "access_revoked", "message": "your access to this document was removed"})
                self.stats["kicked"] += 1
                c.kick(4403, "access revoked")
            else:
                c.role = role
                c.send({"type": "role", "role": role})

    async def _tail_loop(self) -> None:
        while True:
            await asyncio.sleep(self.cfg.tail_check_ms / 1000)
            try:
                await self.check_tails()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("tail_check_failed")

    async def check_tails(self) -> None:
        """Deliver revisions that exist in the DB but never reached this server (lost LAST message)."""
        rooms = {d: r for d, r in self.rooms.items() if r.conns}
        heads = await service.heads(self.sm, list(rooms))
        for doc_id, head in heads.items():
            room = rooms[doc_id]
            if head < room.next_rev:
                continue
            async with room.lock:
                if self.rooms.get(doc_id) is not room or head < room.next_rev:
                    continue
                for o in await service.ops_between(self.sm, doc_id, room.next_rev - 1, head):
                    room.buffer.setdefault(o["rev"], {**o, "type": "op"})
                self.stats["tail_fills"] += 1
                self._flush(room)

    async def _fill_gap_later(self, room: Room) -> None:
        await asyncio.sleep(self.cfg.gap_fill_delay_ms / 1000)
        async with room.lock:
            if not room.buffer:
                return
            upto = min(room.buffer) - 1
            missing = await service.ops_between(self.sm, room.doc_id, room.next_rev - 1, upto)
            self.stats["gap_fills"] += 1
            log.warning("gap_fill", extra={"doc_id": room.doc_id, "from": room.next_rev, "to": upto})
            for o in missing:
                room.buffer.setdefault(o["rev"], {**o, "type": "op"})
            self._flush(room)
