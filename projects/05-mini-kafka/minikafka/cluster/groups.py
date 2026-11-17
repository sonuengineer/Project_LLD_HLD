"""Consumer group coordinator (simplified Kafka classic protocol).

Membership:
  join(group, member_id?, topics) -> blocks until the rebalance completes, returns
      (generation, member_id, assignment). A rebalance starts when a member joins, leaves, or
      misses heartbeats for session_timeout. It completes once every known member has re-joined
      (or rebalance_delay passes; stragglers are kicked out). generation += 1 each time.
  heartbeat(group, member, generation) -> ok | REBALANCE_IN_PROGRESS (re-join!) | errors.
  commit(group, member, generation, offsets) -> fenced: a member from an old generation (a zombie
      that was kicked out while paused) can't commit and overwrite the new owner's progress.

Kafka computes assignments on the group LEADER client (so new strategies need no broker upgrade);
here the coordinator computes it -- same result, fewer round trips. Documented difference.

Committed offsets are appended to an internal log `__consumer_offsets` (key=group|topic|partition,
value=offset) and rebuilt on startup by replaying it, last write wins -- exactly how Kafka's
compacted offsets topic works conceptually.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from ..storage.log import Log
from .assignors import ASSIGNORS
from .errors import IllegalGeneration, RebalanceInProgress, UnknownMemberId, UnknownTopicOrPartition

TP = tuple[str, int]


@dataclass
class Member:
    id: str
    topics: list[str]
    session_timeout_ms: int
    last_heartbeat: float = field(default_factory=time.monotonic)
    assignment: list[TP] = field(default_factory=list)
    joined_generation: int = -1


@dataclass
class Group:
    name: str
    strategy: str = "range"
    generation: int = 0
    state: str = "Empty"           # Empty | PreparingRebalance | Stable
    members: dict[str, Member] = field(default_factory=dict)
    pending: dict[str, asyncio.Future] = field(default_factory=dict)   # members waiting in join()
    rebalance_task: asyncio.Task | None = None
    rebalances: int = 0


class GroupCoordinator:
    def __init__(self, data_dir: Path, partitions_of, *, rebalance_delay_ms: int = 300,
                 min_session_timeout_ms: int = 300, check_interval_ms: int = 50):
        self.groups: dict[str, Group] = {}
        self.offsets: dict[tuple[str, str, int], int] = {}
        self.partitions_of = partitions_of          # callable(topic) -> partition count
        self.delay = rebalance_delay_ms / 1000
        self.min_session = min_session_timeout_ms
        self.check_interval = check_interval_ms / 1000
        self.log = Log(data_dir / "__consumer_offsets-0", segment_bytes=256 * 1024)
        self._load_offsets()
        self._task: asyncio.Task | None = None

    def _load_offsets(self) -> None:
        offset = self.log.log_start_offset
        while True:
            recs = self.log.read(offset, 1024 * 1024)
            if not recs:
                break
            for r in recs:
                g, t, p = r.key.decode().split("|")
                self.offsets[(g, t, int(p))] = json.loads(r.value)["offset"]
            offset = recs[-1].offset + 1

    def start(self) -> None:
        self._task = asyncio.create_task(self._expire_members())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        for g in self.groups.values():
            if g.rebalance_task:
                g.rebalance_task.cancel()
        self.log.close()

    # ---- membership -------------------------------------------------------------------------------
    async def join(self, group: str, member_id: str | None, topics: list[str], *, session_timeout_ms: int = 3000,
                   strategy: str = "range") -> dict:
        for t in topics:
            if self.partitions_of(t) is None:
                raise UnknownTopicOrPartition(t)
        g = self.groups.setdefault(group, Group(group, strategy))
        if member_id is None or member_id not in g.members:
            member_id = member_id or f"consumer-{uuid.uuid4().hex[:8]}"
            g.members[member_id] = Member(member_id, topics, max(session_timeout_ms, self.min_session))
        m = g.members[member_id]
        m.topics = topics
        m.last_heartbeat = time.monotonic()
        fut = asyncio.get_running_loop().create_future()
        old = g.pending.pop(member_id, None)
        if old and not old.done():
            old.cancel()
        g.pending[member_id] = fut
        self._start_rebalance(g, reason=f"{member_id} joined")
        return await fut

    def _start_rebalance(self, g: Group, reason: str) -> None:
        if g.state != "PreparingRebalance":
            g.state = "PreparingRebalance"
            g.rebalance_task = asyncio.create_task(self._complete_rebalance(g))

    async def _complete_rebalance(self, g: Group) -> None:
        # Give existing members (who learn about the rebalance from their next heartbeat) time to re-join.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.delay
        while loop.time() < deadline and set(g.pending) != set(g.members):
            await asyncio.sleep(self.check_interval)
        await asyncio.sleep(0)  # let simultaneous joiners land
        for mid in [m for m in g.members if m not in g.pending]:
            del g.members[mid]       # didn't re-join in time: out of the group
        g.generation += 1
        g.rebalances += 1
        subs = {mid: m.topics for mid, m in g.members.items()}
        parts = {t: self.partitions_of(t) or 0 for ts in subs.values() for t in ts}
        assignment = ASSIGNORS[g.strategy](subs, parts) if subs else {}
        g.state = "Stable" if g.members else "Empty"
        leader = min(g.members) if g.members else None
        for mid, fut in list(g.pending.items()):
            m = g.members.get(mid)
            if m is None or fut.done():
                continue
            m.assignment = assignment.get(mid, [])
            m.joined_generation = g.generation
            m.last_heartbeat = time.monotonic()
            fut.set_result({"generation": g.generation, "member_id": mid, "leader": leader,
                            "assignment": [list(tp) for tp in m.assignment]})
        g.pending.clear()

    def heartbeat(self, group: str, member_id: str, generation: int) -> None:
        g = self.groups.get(group)
        if g is None or member_id not in g.members:
            raise UnknownMemberId(member_id)
        m = g.members[member_id]
        m.last_heartbeat = time.monotonic()
        if g.state == "PreparingRebalance":
            raise RebalanceInProgress("re-join the group")
        if generation != g.generation:
            raise IllegalGeneration(f"generation {generation} != {g.generation}")

    def leave(self, group: str, member_id: str) -> None:
        g = self.groups.get(group)
        if g and g.members.pop(member_id, None):
            g.pending.pop(member_id, None)
            self._start_rebalance(g, reason=f"{member_id} left")

    async def _expire_members(self) -> None:
        while True:
            await asyncio.sleep(self.check_interval)
            now = time.monotonic()
            for g in self.groups.values():
                if g.state != "Stable":
                    continue
                dead = [mid for mid, m in g.members.items() if now - m.last_heartbeat > m.session_timeout_ms / 1000]
                for mid in dead:
                    del g.members[mid]
                if dead:
                    self._start_rebalance(g, reason=f"session expired: {dead}")

    # ---- offsets ----------------------------------------------------------------------------------
    def commit(self, group: str, member_id: str | None, generation: int, offsets: dict[TP, int]) -> None:
        g = self.groups.get(group)
        if member_id is not None:          # member_id None = admin/standalone commit (no group fencing)
            if g is None or member_id not in g.members:
                raise UnknownMemberId(member_id)
            if generation != g.generation:
                raise IllegalGeneration(f"commit from generation {generation}, group is at {g.generation}")
            # Commits during PreparingRebalance from the CURRENT generation are allowed: that's how a
            # consumer saves progress for partitions it is about to give up, before re-joining.
            owned = set(g.members[member_id].assignment)
            not_owned = [tp for tp in offsets if tp not in owned]
            if not_owned:
                raise IllegalGeneration(f"member does not own {not_owned}")
        self.log.append([(f"{group}|{t}|{p}".encode(), json.dumps({"offset": o}).encode())
                         for (t, p), o in offsets.items()])
        self.log.flush(fsync=True)
        for (t, p), o in offsets.items():
            self.offsets[(group, t, p)] = o

    def committed(self, group: str) -> dict[TP, int]:
        return {(t, p): o for (g, t, p), o in self.offsets.items() if g == group}

    def describe(self, group: str) -> dict:
        g = self.groups.get(group)
        if g is None:
            return {"group": group, "state": "Dead", "members": []}
        return {"group": group, "state": g.state, "generation": g.generation, "strategy": g.strategy,
                "rebalances": g.rebalances,
                "members": [{"id": m.id, "topics": m.topics, "assignment": [list(tp) for tp in m.assignment],
                             "seconds_since_heartbeat": round(time.monotonic() - m.last_heartbeat, 2)}
                            for m in g.members.values()]}
