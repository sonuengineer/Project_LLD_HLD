"""Replica side of master -> replica asynchronous replication.

Protocol (simplified Redis full sync):
  replica -> master : SYNC
  master  -> replica: $<len>\\r\\n<snapshot bytes>        (full copy of the dataset)
  master  -> replica: *N\\r\\n...  write commands, forever  (the replication stream)
  replica -> master : REPLCONF ACK <offset>  every second  (lets the master see lag)

Asynchronous: the master replies to its client WITHOUT waiting for replicas. A write
acknowledged by the master can be lost if the master dies before streaming it.

No partial resync (PSYNC + backlog) here: every reconnect is a full sync. Documented
as the main production gap.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from .persistence import snapshot
from .protocol import Parser, encode_command

if TYPE_CHECKING:
    from .server import Server

log = logging.getLogger(__name__)


class ReplicaLink:
    def __init__(self, server: "Server", host: str, port: int):
        self.server = server
        self.host, self.port = host, port
        self.state = "connecting"   # connecting | sync | connected
        self.offset = 0
        self.full_syncs = 0
        self.last_io = 0.0
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="replica-link")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def _run(self) -> None:
        backoff = 0.1
        while True:
            try:
                await self._sync_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # connection refused/reset, bad payload ...
                log.warning("replication_link_down", extra={"master": f"{self.host}:{self.port}", "error": repr(exc)})
            self.state = "connecting"
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 2.0)

    async def _sync_once(self) -> None:
        reader, writer = await asyncio.open_connection(self.host, self.port)
        ack_task = None
        try:
            self.state = "sync"
            writer.write(encode_command([b"SYNC"]))
            await writer.drain()
            header = await reader.readuntil(b"\r\n")
            if not header.startswith(b"$"):
                raise RuntimeError(f"unexpected SYNC reply {header!r}")
            payload = await reader.readexactly(int(header[1:-2]))
            n = snapshot.load(payload, self.server.ks)  # replaces the whole dataset
            self.full_syncs += 1
            self.offset = 0
            self.state = "connected"
            log.info("replication_full_sync_done", extra={"keys": n, "bytes": len(payload)})
            ack_task = asyncio.create_task(self._ack_loop(writer))
            parser = Parser()
            loop = asyncio.get_running_loop()
            while True:
                data = await reader.read(65536)
                if not data:
                    raise ConnectionError("master closed the connection")
                self.last_io = loop.time()
                parser.feed(data)
                while True:
                    before = parser.pending
                    args = parser.get_command()
                    if args is None:
                        break
                    self.offset += before - parser.pending
                    self.server.apply_from_master(args)
        finally:
            if ack_task:
                ack_task.cancel()
            writer.close()

    async def _ack_loop(self, writer: asyncio.StreamWriter) -> None:
        while True:
            await asyncio.sleep(1)
            writer.write(encode_command([b"REPLCONF", b"ACK", str(self.offset).encode()]))
            await writer.drain()
