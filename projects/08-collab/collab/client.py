"""Reference OT client (Python). Same state machine as ot.js:

    Synchronized        no local change in flight
    AwaitingConfirm     one op sent (outstanding), waiting for its ack
    AwaitingWithBuffer  outstanding op in flight + further local edits composed into `buffer`

Incoming server op S (someone else's, already ordered by the server):
    outstanding', S'  = transform(outstanding, S)
    buffer', S''      = transform(buffer, S')
    apply S'' to the local text            -> our pending edits stay on top of everyone else's
Ack for our outstanding op: buffer (if any) becomes the new outstanding and is sent.

Offline: edits keep composing into the buffer. Reconnect: join with last_rev -> the server sends the
missed ops (our own ones come back as acks), then 'joined'; we then resend what is still unacked with the
SAME client_seq, so a resend of an op whose ack was lost is deduplicated by the server.

Rejected op (error with our outstanding client_seq): that op will never be acked, and everything buffered
on top of it depends on it. Waiting would stall the client forever, so it resyncs: drop the pending
edits and reload the document from the server (the user loses only the edits the server refused).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid

import websockets

from .ot import TextOp, apply, compose, transform


class CollabClient:
    def __init__(self, ws_url: str, doc_id: str, ticket_factory, client_id: str | None = None):
        self.ws_url, self.doc_id, self.ticket_factory = ws_url, str(doc_id), ticket_factory
        self.client_id = client_id or uuid.uuid4().hex
        self.doc = ""
        self.rev = 0
        self.outstanding: tuple[int, TextOp] | None = None      # (client_seq, op)
        self.buffer: TextOp | None = None
        self.next_seq = 1
        self.ws = None
        self.joined = asyncio.Event()
        self.connected = False
        self.received_ops = 0
        self.errors: list[dict] = []
        self.presence_events: list[dict] = []
        self._reader: asyncio.Task | None = None
        self._first_join = True
        self.resyncs = 0
        self._resync_task: asyncio.Task | None = None

    # ---- connection -----------------------------------------------------------------------------------
    async def connect(self) -> None:
        ticket = await self.ticket_factory()
        self.ws = await websockets.connect(f"{self.ws_url}?ticket={ticket}", max_size=2**23)
        self.joined.clear()
        join = {"type": "join", "doc_id": self.doc_id, "client_id": self.client_id}
        if not self._first_join:
            join["last_rev"] = self.rev           # reconnect: only fetch what we missed
        await self.ws.send(json.dumps(join))
        self.connected = True
        self._reader = asyncio.create_task(self._read_loop())
        await asyncio.wait_for(self.joined.wait(), 10)

    async def disconnect(self) -> None:
        """Simulates going offline: local edits continue and are buffered."""
        self.connected = False
        if self._reader:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader
        if self.ws:
            with contextlib.suppress(Exception):
                await self.ws.close()

    async def resync(self) -> None:
        """Discard pending local edits and reload the document (fresh join, no last_rev)."""
        self.resyncs += 1
        await self.disconnect()
        self.outstanding = self.buffer = None
        self._first_join = True
        await self.connect()

    async def _read_loop(self) -> None:
        try:
            async for raw in self.ws:
                await self._handle(json.loads(raw))
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        finally:
            self.connected = False

    async def _handle(self, m: dict) -> None:
        t = m["type"]
        if t == "joined":
            if not m.get("catchup"):
                self.doc, self.rev = m["content"], m["rev"]
            self._first_join = False
            self.joined.set()
            if self.outstanding:                       # resend unacked op with the SAME seq (dedupe on server)
                await self._send_op(*self.outstanding)
            elif self.buffer:
                await self._flush_buffer()
        elif t == "op":
            self._server_op(m["rev"], TextOp.from_json(m["op"]))
        elif t == "ack":
            self._ack(m["rev"])
            await self._flush_buffer()
        elif t == "error":
            self.errors.append(m)
            if self.outstanding and m.get("client_seq") == self.outstanding[0] and m.get("code") != "access_revoked":
                self._resync_task = asyncio.create_task(self.resync())
        elif t == "presence":
            self.presence_events.append(m)

    # ---- OT state machine ---------------------------------------------------------------------------
    def _server_op(self, rev: int, op: TextOp) -> None:
        self.received_ops += 1
        if self.outstanding:
            seq, out = self.outstanding
            out, op = transform(out, op)
            self.outstanding = (seq, out)
        # Independent of `outstanding`: offline edits sit in `buffer` with NOTHING outstanding (a state ot.js
        # doesn't have). Transforming against the buffer only when an op was outstanding corrupted offline
        # clients on reconnect (found by the fuzz test).
        if self.buffer:
            self.buffer, op = transform(self.buffer, op)
        self.doc = apply(self.doc, op)
        self.rev = rev

    def _ack(self, rev: int) -> None:
        self.outstanding = None
        self.rev = rev

    async def _flush_buffer(self) -> None:
        if self.outstanding is None and self.buffer is not None and self.connected and self.joined.is_set():
            seq, op = self.next_seq, self.buffer
            self.next_seq += 1
            self.buffer = None
            self.outstanding = (seq, op)
            await self._send_op(seq, op)

    async def _send_op(self, seq: int, op: TextOp) -> None:
        # base_rev = last server revision we have applied; the server transforms against anything newer.
        with contextlib.suppress(websockets.ConnectionClosed):
            await self.ws.send(json.dumps({"type": "op", "client_seq": seq, "base_rev": self.rev, "op": op.to_json()}))

    # ---- local edits --------------------------------------------------------------------------------
    async def edit(self, op: TextOp) -> None:
        self.doc = apply(self.doc, op)
        self.buffer = op if self.buffer is None else compose(self.buffer, op)
        await self._flush_buffer()

    async def insert(self, pos: int, s: str) -> None:
        await self.edit(TextOp().retain(pos).insert(s).retain(len(self.doc) - pos))

    async def delete(self, pos: int, n: int) -> None:
        await self.edit(TextOp().retain(pos).delete(n).retain(len(self.doc) - pos - n))

    async def send_cursor(self, position: int) -> None:
        await self.ws.send(json.dumps({"type": "cursor", "position": position, "rev": self.rev}))

    @property
    def settled(self) -> bool:
        return self.outstanding is None and self.buffer is None
