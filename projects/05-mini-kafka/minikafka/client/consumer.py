"""Group consumer client.

Delivery semantics depend on WHEN you commit:
  process, then commit   -> at-least-once (crash between them = reprocess)   <- default here
  commit, then process   -> at-most-once  (crash between them = message skipped)
  exactly-once           -> needs the processing result and the offset written atomically
                            (same DB transaction, or Kafka transactions) -- not provided here.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)
TP = tuple[str, int]


@dataclass
class ConsumerRecord:
    topic: str
    partition: int
    offset: int
    timestamp: int
    key: str | None
    value: str


class Consumer:
    def __init__(self, group: str, topics: list[str], base_url: str = "http://127.0.0.1:8005", *,
                 transport: httpx.AsyncBaseTransport | None = None, auto_offset_reset: str = "earliest",
                 session_timeout_ms: int = 10_000, heartbeat_interval_ms: int = 1000, strategy: str = "range",
                 max_bytes_per_partition: int = 256 * 1024, on_revoke=None, on_assign=None):
        self.http = httpx.AsyncClient(base_url=base_url, transport=transport, timeout=60)
        self.group, self.topics = group, topics
        self.reset = auto_offset_reset
        self.session_ms, self.hb = session_timeout_ms, heartbeat_interval_ms / 1000
        self.strategy, self.max_bytes = strategy, max_bytes_per_partition
        self.on_revoke, self.on_assign = on_revoke, on_assign
        self.member_id: str | None = None
        self.generation = -1
        self.assignment: list[TP] = []
        self.positions: dict[TP, int] = {}
        self._needs_rejoin = True
        self._hb_task: asyncio.Task | None = None
        self.rebalances = 0

    # ---- membership -------------------------------------------------------------------------------
    async def _join(self) -> None:
        if self.assignment and self.on_revoke:
            await self.on_revoke(self, list(self.assignment))   # e.g. commit before giving partitions up
        r = (await self.http.post(f"/groups/{self.group}/join", json={
            "member_id": self.member_id, "topics": self.topics, "session_timeout_ms": self.session_ms,
            "strategy": self.strategy})).json()
        self.member_id, self.generation = r["member_id"], r["generation"]
        self.assignment = [tuple(x) for x in r["assignment"]]
        self.rebalances += 1
        committed = {(o["topic"], o["partition"]): o["committed"]
                     for o in (await self.http.get(f"/groups/{self.group}")).json()["lag"]}
        self.positions = {}
        for tp in self.assignment:
            if tp in committed:
                self.positions[tp] = committed[tp]
            else:
                o = (await self.http.get(f"/topics/{tp[0]}/partitions/{tp[1]}/offsets")).json()
                self.positions[tp] = o["log_start_offset"] if self.reset == "earliest" else o["high_watermark"]
        self._needs_rejoin = False
        if self.on_assign:
            await self.on_assign(self, list(self.assignment))
        if self._hb_task is None or self._hb_task.done():
            self._hb_task = asyncio.create_task(self._heartbeat_loop())

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self.hb)
            try:
                r = await self.http.post(f"/groups/{self.group}/heartbeat",
                                         json={"member_id": self.member_id, "generation": self.generation})
                if r.status_code != 200:
                    code = r.json()["error"]["code"]
                    if code in ("rebalance_in_progress", "illegal_generation", "unknown_member_id"):
                        if code == "unknown_member_id":
                            self.member_id = None           # we were kicked out (e.g. paused too long)
                        self._needs_rejoin = True
            except httpx.TransportError:
                pass

    # ---- consuming --------------------------------------------------------------------------------
    async def poll(self, wait_ms: int = 200) -> list[ConsumerRecord]:
        if self._needs_rejoin:
            await self._join()
        if not self.assignment:
            await asyncio.sleep(wait_ms / 1000)
            return []

        async def one(tp: TP) -> list[ConsumerRecord]:
            r = await self.http.get(f"/topics/{tp[0]}/partitions/{tp[1]}/fetch",
                                    params={"offset": self.positions[tp], "max_bytes": self.max_bytes,
                                            "wait_ms": wait_ms})
            if r.status_code != 200:
                err = r.json()["error"]
                if err["code"] == "offset_out_of_range":     # deleted by retention -> jump to log start
                    o = (await self.http.get(f"/topics/{tp[0]}/partitions/{tp[1]}/offsets")).json()
                    self.positions[tp] = o["log_start_offset"]
                return []
            recs = [ConsumerRecord(tp[0], tp[1], x["offset"], x["timestamp"], x["key"], x["value"])
                    for x in r.json()["records"]]
            if recs:
                self.positions[tp] = recs[-1].offset + 1
            return recs

        out: list[ConsumerRecord] = []
        for recs in await asyncio.gather(*[one(tp) for tp in self.assignment]):
            out += recs
        return out

    async def commit(self, offsets: dict[TP, int] | None = None) -> bool:
        """Commit `offsets` (default: current positions = 'everything returned by poll is done').
        Returns False if fenced (we're no longer the owner) -> caller should expect a rejoin."""
        offsets = offsets if offsets is not None else dict(self.positions)
        if not offsets:
            return True
        r = await self.http.post(f"/groups/{self.group}/commit", json={
            "member_id": self.member_id, "generation": self.generation,
            "offsets": [{"topic": t, "partition": p, "offset": o} for (t, p), o in offsets.items()]})
        if r.status_code != 200:
            log.warning("commit_rejected", extra={"error": r.json()["error"]})
            self._needs_rejoin = True
            return False
        return True

    def seek(self, tp: TP, offset: int) -> None:
        """Replay: move the position back (or forward). Takes effect on the next poll."""
        self.positions[tp] = offset

    async def close(self, leave: bool = True) -> None:
        if self._hb_task:
            self._hb_task.cancel()
        if leave and self.member_id:
            await self.http.post(f"/groups/{self.group}/leave", json={"member_id": self.member_id})
        await self.http.aclose()
