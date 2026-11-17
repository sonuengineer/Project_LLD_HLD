import asyncio

import pytest

from minikafka.cluster.assignors import range_assign, roundrobin_assign
from minikafka.cluster.errors import IllegalGeneration, RebalanceInProgress, UnknownMemberId

from .conftest import eventually, running_cluster


def test_range_assignor():
    a = range_assign({"c1": ["t"], "c2": ["t"], "c3": ["t"]}, {"t": 7})
    assert a == {"c1": [("t", 0), ("t", 1), ("t", 2)], "c2": [("t", 3), ("t", 4)], "c3": [("t", 5), ("t", 6)]}


def test_range_vs_roundrobin_with_many_topics():
    members = {"c1": ["a", "b", "c"], "c2": ["a", "b", "c"]}
    parts = {"a": 3, "b": 3, "c": 3}
    r = range_assign(members, parts)
    rr = roundrobin_assign(members, parts)
    assert (len(r["c1"]), len(r["c2"])) == (6, 3)        # range: c1 gets the extra of EVERY topic
    assert sorted((len(rr["c1"]), len(rr["c2"]))) == [4, 5]   # roundrobin: balanced
    assert sorted(tp for v in rr.values() for tp in v) == sorted(tp for v in r.values() for tp in v)


def test_more_consumers_than_partitions_leaves_some_idle():
    a = range_assign({f"c{i}": ["t"] for i in range(5)}, {"t": 3})
    assert sorted(len(v) for v in a.values()) == [0, 0, 1, 1, 1]


class MemberSim:
    """Behaves like a well-behaved consumer: heartbeats, re-joins when told to."""

    def __init__(self, coord, group, topics, session_ms=400):
        self.c, self.group, self.topics, self.session = coord, group, topics, session_ms
        self.id = None
        self.gen = -1
        self.assignment = []
        self.alive = True
        self.task = None

    async def start(self):
        await self._join()
        self.task = asyncio.create_task(self._loop())

    async def _join(self):
        r = await self.c.join(self.group, self.id, self.topics, session_timeout_ms=self.session)
        self.id, self.gen, self.assignment = r["member_id"], r["generation"], [tuple(x) for x in r["assignment"]]

    async def _loop(self):
        while self.alive:
            await asyncio.sleep(0.05)
            try:
                self.c.heartbeat(self.group, self.id, self.gen)
            except (RebalanceInProgress, IllegalGeneration, UnknownMemberId):
                await self._join()

    async def crash(self):
        self.alive = False
        self.task.cancel()


async def test_join_split_rebalance_and_failover(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 4, 1)
        a, b = MemberSim(c.groups, "g", ["t"]), MemberSim(c.groups, "g", ["t"])
        await asyncio.gather(a.start(), b.start())
        assert a.gen == b.gen == 1
        assert sorted(a.assignment + b.assignment) == [("t", i) for i in range(4)]
        assert len(a.assignment) == len(b.assignment) == 2
        c3 = MemberSim(c.groups, "g", ["t"])
        await c3.start()                                     # triggers a rebalance for everyone
        assert await eventually(lambda: a.gen == b.gen == c3.gen == 2)
        assert sorted(a.assignment + b.assignment + c3.assignment) == [("t", i) for i in range(4)]
        await b.crash()                                      # no leave, just silence
        assert await eventually(lambda: a.gen == c3.gen == 3, timeout=3)
        assert sorted(a.assignment + c3.assignment) == [("t", i) for i in range(4)]
        assert {m["id"] for m in c.groups.describe("g")["members"]} == {a.id, c3.id}
        await a.crash()
        await c3.crash()


async def test_commit_fencing_and_ownership(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 2, 1)
        a = MemberSim(c.groups, "g", ["t"])
        await a.start()
        c.groups.commit("g", a.id, a.gen, {("t", 0): 10})
        with pytest.raises(IllegalGeneration):
            c.groups.commit("g", a.id, a.gen - 1, {("t", 0): 11})       # zombie from older generation
        with pytest.raises(UnknownMemberId):
            c.groups.commit("g", "nobody", a.gen, {("t", 0): 11})
        b = MemberSim(c.groups, "g", ["t"])
        await b.start()
        assert await eventually(lambda: a.gen == b.gen == 2)
        foreign = next(tp for tp in [("t", 0), ("t", 1)] if tp not in a.assignment)
        with pytest.raises(IllegalGeneration):
            c.groups.commit("g", a.id, a.gen, {foreign: 99})             # can't commit a partition you don't own
        assert c.groups.committed("g") == {("t", 0): 10}
        await a.crash()
        await b.crash()


async def test_leave_triggers_fast_rebalance(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 2, 1)
        a, b = MemberSim(c.groups, "g", ["t"]), MemberSim(c.groups, "g", ["t"])
        await asyncio.gather(a.start(), b.start())
        b.alive = False
        b.task.cancel()
        c.groups.leave("g", b.id)                        # graceful shutdown: no session-timeout wait
        assert await eventually(lambda: a.gen == 2 and len(a.assignment) == 2, timeout=1)
        await a.crash()


async def test_committed_offsets_survive_restart(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 2, 1)
        c.groups.commit("g", None, -1, {("t", 0): 5, ("t", 1): 7})
        c.groups.commit("g", None, -1, {("t", 0): 9})                  # newer value for t-0
    async with running_cluster(tmp_path) as c:
        assert c.groups.committed("g") == {("t", 0): 9, ("t", 1): 7}   # rebuilt from __consumer_offsets
