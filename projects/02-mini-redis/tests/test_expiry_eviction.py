"""Expiry and eviction with a controllable clock (unit level) + OOM behaviour (server level)."""
import pytest
from redis.exceptions import ResponseError

from minidis.keyspace import EvictionPolicy, Keyspace

from .conftest import client_for, running


class Clock:
    def __init__(self, t=1_000_000):
        self.t = t

    def __call__(self):
        return self.t


def test_lazy_expiry_on_access():
    clock = Clock()
    ks = Keyspace(clock=clock)
    ks.store(b"k", b"v")
    ks.set_expire_at(b"k", clock.t + 100)
    assert ks.lookup(b"k") == b"v"
    clock.t += 100
    assert ks.lookup(b"k") is None
    assert b"k" not in ks.data and ks.stats.expired_keys == 1


def test_active_expiry_removes_keys_nobody_reads():
    clock = Clock()
    ks = Keyspace(clock=clock)
    for i in range(1000):
        ks.store(b"tmp%d" % i, b"v")
        ks.set_expire_at(b"tmp%d" % i, clock.t + 10)
    for i in range(100):
        ks.store(b"keep%d" % i, b"v")
    clock.t += 11
    cycles = 0
    while len(ks.expires) and cycles < 200:
        ks.active_expire_cycle()
        cycles += 1
    assert len(ks.expires) == 0 and len(ks.data) == 100   # only persistent keys left
    assert ks.stats.expired_keys == 1000


def test_replica_hides_but_does_not_delete_expired_keys():
    clock = Clock()
    ks = Keyspace(clock=clock, is_replica=True)
    ks.store(b"k", b"v")
    ks.set_expire_at(b"k", clock.t + 1)
    clock.t += 5
    assert ks.lookup(b"k") is None
    assert b"k" in ks.data           # waits for the master's DEL
    assert ks.active_expire_cycle() == 0


def test_implicit_deletes_are_reported_for_propagation():
    clock = Clock()
    seen = []
    ks = Keyspace(clock=clock, on_implicit_delete=seen.append)
    ks.store(b"k", b"v")
    ks.set_expire_at(b"k", clock.t)
    ks.lookup(b"k")
    assert seen == [[b"DEL", b"k"]]


def test_allkeys_lru_evicts_least_recently_used():
    ks = Keyspace()
    for k in (b"a", b"b", b"c"):
        ks.store(k, b"x" * 100)
    ks.lookup(b"a")  # a is now most recently used; b is the oldest
    limit = ks.used_memory - 1
    assert ks.evict_until_fits(limit, EvictionPolicy.ALLKEYS_LRU)
    assert set(ks.data) == {b"a", b"c"} and ks.stats.evicted_keys == 1


def test_volatile_ttl_evicts_soonest_expiring_and_spares_persistent():
    clock = Clock()
    ks = Keyspace(clock=clock)
    ks.store(b"persistent", b"x" * 100)
    ks.store(b"soon", b"x" * 100)
    ks.set_expire_at(b"soon", clock.t + 10)
    ks.store(b"later", b"x" * 100)
    ks.set_expire_at(b"later", clock.t + 10_000)
    assert ks.evict_until_fits(ks.used_memory - 1, EvictionPolicy.VOLATILE_TTL, samples=10)
    assert b"soon" not in ks.data and b"persistent" in ks.data


def test_volatile_policy_cannot_free_persistent_keys():
    ks = Keyspace()
    ks.store(b"p", b"x" * 100)
    assert ks.evict_until_fits(10, EvictionPolicy.VOLATILE_LRU) is False


def test_memory_accounting_returns_to_zero():
    ks = Keyspace()
    ks.store(b"s", b"abc")
    from collections import deque
    lst = ks.lookup_typed(b"l", deque, create=deque)
    lst.append(b"xyz")
    ks.adjust_size(b"l", 3 + 16)
    ks.delete(b"s")
    ks.delete(b"l")
    assert ks.used_memory == 0


async def test_noeviction_returns_oom_error(tmp_path):
    async with running(tmp_path, maxmemory=2000) as s:
        c = client_for(s)
        with pytest.raises(ResponseError, match="maxmemory"):  # redis-py strips the OOM prefix
            for i in range(100):
                await c.set(f"k{i}", "x" * 100)
        assert await c.get("k0") == b"x" * 100  # reads still work
        # Regression: commands that FREE memory must not be refused with OOM.
        assert await c.delete("k0") == 1
        assert await c.set("after-del", "x" * 100)   # space freed -> writes work again
        await c.aclose()


async def test_allkeys_lru_server_keeps_hot_key(tmp_path):
    async with running(tmp_path, maxmemory=5000, maxmemory_policy=EvictionPolicy.ALLKEYS_LRU) as s:
        c = client_for(s)
        await c.set("hot", "x" * 100)
        for i in range(200):
            await c.set(f"cold{i}", "x" * 100)
            await c.get("hot")  # keep it recently used
        assert await c.get("hot") is not None
        info = await c.info("stats")
        assert info["evicted_keys"] > 0
        await c.aclose()


def test_replica_physically_deletes_on_master_del():
    """Regression: replica used to ignore DEL for a logically-expired key -> memory leak."""
    clock = Clock()
    ks = Keyspace(clock=clock, is_replica=True)
    ks.store(b"k", b"v")
    ks.set_expire_at(b"k", clock.t + 1)
    clock.t += 5
    assert ks.delete(b"k") is False      # reply semantics: it was already (logically) gone
    assert b"k" not in ks.data and ks.used_memory == 0
