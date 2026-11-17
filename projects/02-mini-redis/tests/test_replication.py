import asyncio

import pytest
from redis.exceptions import ReadOnlyError

from .conftest import client_for, running


async def wait_for(predicate, timeout=3.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if await predicate():
            return True
        await asyncio.sleep(0.02)
    return False


async def test_full_sync_then_stream(tmp_path):
    async with running(tmp_path / "m") as master:
        m = client_for(master)
        await m.set("before", "sync")
        async with running(tmp_path / "r", replicaof=("127.0.0.1", master.port)) as replica:
            r = client_for(replica)
            assert await wait_for(lambda: _eq(r.get("before"), b"sync"))
            await m.rpush("l", "a", "b")
            await m.hset("h", "f", "v")
            await m.incr("n")
            assert await wait_for(lambda: _eq(r.get("n"), b"1"))
            assert await r.lrange("l", 0, -1) == [b"a", b"b"] and await r.hget("h", "f") == b"v"
            info = await r.info("replication")
            assert info["role"] == "slave" and info["master_link_status"] == "up"
            await r.aclose()
        await m.aclose()


async def _eq(coro, expected):
    return (await coro) == expected


async def test_replica_is_read_only(tmp_path):
    async with running(tmp_path / "m") as master, \
            running(tmp_path / "r", replicaof=("127.0.0.1", master.port)) as replica:
        r = client_for(replica)
        with pytest.raises(ReadOnlyError):  # redis-py maps the READONLY prefix to this type
            await r.set("x", "1")
        await r.aclose()


async def test_master_expiry_propagates_as_del(tmp_path):
    async with running(tmp_path / "m") as master, \
            running(tmp_path / "r", replicaof=("127.0.0.1", master.port)) as replica:
        m, r = client_for(master), client_for(replica)
        assert await wait_for(lambda: _has_replica(master))   # stream is live, not just full sync
        await m.set("k", "v", px=300)
        assert await wait_for(lambda: _eq(r.exists("k"), 1))
        await asyncio.sleep(0.35)
        assert await r.exists("k") == 0          # replica hides it (logically expired) ...
        assert b"k" in replica.ks.data           # ... but keeps it until the master says DEL
        await m.get("k")  # lazy expiry on master -> DEL propagated
        assert await wait_for(lambda: _contains_not(replica, b"k"))
        await m.aclose()
        await r.aclose()


async def _contains_not(server, key):
    return key not in server.ks.data


async def test_replica_resyncs_after_master_restart(tmp_path):
    mdir = tmp_path / "m"
    async with running(mdir) as master:
        port = master.port
        m = client_for(master)
        await m.set("a", "1")
        await m.save()
        await m.aclose()
    # replica starts while master is down -> keeps retrying with backoff
    async with running(tmp_path / "r", replicaof=("127.0.0.1", port)) as replica:
        r = client_for(replica)
        from minidis.config import ServerConfig
        from minidis.server import Server
        master2 = Server(ServerConfig(port=port, dir=mdir, save_rules=[]))
        await master2.start()
        try:
            assert await wait_for(lambda: _eq(r.get("a"), b"1"), timeout=5)
            m2 = client_for(master2)
            await m2.set("b", "2")
            assert await wait_for(lambda: _eq(r.get("b"), b"2"))
            await m2.aclose()
        finally:
            await master2.stop()
        await r.aclose()


async def test_promote_replica(tmp_path):
    async with running(tmp_path / "m") as master, \
            running(tmp_path / "r", replicaof=("127.0.0.1", master.port)) as replica:
        r = client_for(replica)
        await r.execute_command("REPLICAOF", "NO", "ONE")
        assert await r.set("x", "1")
        assert (await r.info("replication"))["role"] == "master"
        await r.aclose()


async def test_master_reports_replica_ack_offset(tmp_path):
    async with running(tmp_path / "m") as master, \
            running(tmp_path / "r", replicaof=("127.0.0.1", master.port)) as replica:
        m = client_for(master)
        assert await wait_for(lambda: _has_replica(master))
        await m.set("k", "v")
        assert await wait_for(lambda: _acked(master), timeout=4)
        info = await m.info("replication")
        assert info["connected_slaves"] == 1
        await m.aclose()


async def _has_replica(master):
    return len(master.replicas) == 1


async def _acked(master):
    return any(r.ack_offset == master.master_repl_offset > 0 for r in master.replicas.values())


async def test_lag_bytes_is_zero_for_caught_up_replica_attached_late(tmp_path):
    """Regression: a replica attached AFTER earlier writes reported lag_bytes > 0 forever."""
    async with running(tmp_path / "m") as master:
        m = client_for(master)
        for i in range(20):
            await m.set(f"early{i}", "x" * 10)   # advances master_repl_offset before any replica
        async with running(tmp_path / "r", replicaof=("127.0.0.1", master.port)) as replica:
            assert await wait_for(lambda: _has_replica(master))
            await m.set("late", "v")
            assert await wait_for(lambda: _lag_zero(m), timeout=4)
        await m.aclose()


async def _lag_zero(m):
    info = await m.info("replication")
    s = info.get("slave0")
    lag = s["lag_bytes"] if isinstance(s, dict) else int(str(s).split("lag_bytes=")[1])
    return lag == 0
