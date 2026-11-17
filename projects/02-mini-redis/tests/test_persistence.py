import asyncio
import os

import pytest

from minidis.keyspace import Keyspace
from minidis.persistence import snapshot
from minidis.persistence.aof import AppendOnlyFile

from .conftest import client_for, running


async def _fill(c):
    await c.set("s", "hello")
    await c.rpush("l", "a", "b", "c")
    await c.sadd("set", "x", "y")
    await c.hset("h", mapping={"f": "v", "g": "w"})
    await c.set("ttl", "v", ex=100)
    for _ in range(50):
        await c.incr("counter")


async def _check(c):
    assert await c.get("s") == b"hello"
    assert await c.lrange("l", 0, -1) == [b"a", b"b", b"c"]
    assert await c.smembers("set") == {b"x", b"y"}
    assert await c.hgetall("h") == {b"f": b"v", b"g": b"w"}
    assert await c.get("counter") == b"50"
    assert 90 < await c.ttl("ttl") <= 100


async def test_snapshot_restart(tmp_path):
    async with running(tmp_path) as s:
        c = client_for(s)
        await _fill(c)
        assert await c.save()
        await c.aclose()
    async with running(tmp_path) as s:
        assert s.persistence.loaded_from.startswith("snapshot")
        c = client_for(s)
        await _check(c)
        await c.aclose()


async def test_bgsave_writes_snapshot(tmp_path):
    async with running(tmp_path) as s:
        c = client_for(s)
        await c.set("k", "v")
        assert await c.bgsave()
        for _ in range(50):
            if (await c.info("persistence"))["rdb_bgsave_in_progress"] == 0:
                break
            await asyncio.sleep(0.02)
        info = await c.info("persistence")
        assert info["rdb_last_bgsave_status"] == "ok" and info["rdb_changes_since_last_save"] == 0
        await c.aclose()
    assert (tmp_path / "dump.mdb").exists()


def test_corrupted_snapshot_is_rejected():
    ks = Keyspace()
    ks.store(b"k", b"v")
    data = bytearray(snapshot.dump(ks))
    data[12] ^= 0xFF   # flip a bit
    with pytest.raises(snapshot.CorruptSnapshot):
        snapshot.load(bytes(data), Keyspace())
    with pytest.raises(snapshot.CorruptSnapshot):
        snapshot.load(bytes(data[:-3]), Keyspace())  # truncated


@pytest.mark.parametrize("fsync", ["always", "everysec", "no"])
async def test_aof_restart_without_snapshot(tmp_path, fsync):
    async with running(tmp_path, appendonly=True, appendfsync=fsync, save_on_shutdown=False) as s:
        c = client_for(s)
        await _fill(c)
        await c.aclose()
    assert not (tmp_path / "dump.mdb").exists()
    async with running(tmp_path, appendonly=True) as s:
        assert s.persistence.loaded_from.startswith("aof")
        c = client_for(s)
        await _check(c)
        await c.aclose()


async def test_aof_stores_absolute_expiry(tmp_path):
    async with running(tmp_path, appendonly=True) as s:
        c = client_for(s)
        await c.set("k", "v", ex=100)
        await c.expire("k", 200)
        await c.aclose()
    text = (tmp_path / "appendonly.aof").read_bytes()
    assert b"PEXPIREAT" in text and b"EX" not in text.replace(b"PEXPIREAT", b"")


async def test_aof_truncated_tail_is_recovered(tmp_path):
    async with running(tmp_path, appendonly=True, appendfsync="always") as s:
        c = client_for(s)
        await c.set("a", "1")
        await c.set("b", "2")
        await c.aclose()
    path = tmp_path / "appendonly.aof"
    good_size = path.stat().st_size
    with open(path, "ab") as f:
        f.write(b"*3\r\n$3\r\nSET\r\n$1\r\nc\r\n$1")  # crash in the middle of writing a command
    async with running(tmp_path, appendonly=True) as s:
        assert "truncated" in s.persistence.loaded_from
        c = client_for(s)
        assert await c.get("a") == b"1" and await c.get("b") == b"2" and await c.get("c") is None
        await c.aclose()
    assert path.stat().st_size >= good_size


async def test_aof_rewrite_shrinks_and_keeps_concurrent_writes(tmp_path):
    async with running(tmp_path, appendonly=True) as s:
        c = client_for(s)
        for _ in range(500):
            await c.incr("n")
        await c.rpush("l", *[str(i) for i in range(200)])
        before = (await c.info("persistence"))["aof_current_size"]
        await c.bgrewriteaof()
        await c.set("during", "rewrite")   # lands in the rewrite buffer
        for _ in range(100):
            if (await c.info("persistence"))["aof_rewrite_in_progress"] == 0:
                break
            await asyncio.sleep(0.02)
        await c.set("after", "rewrite")
        after = (await c.info("persistence"))["aof_current_size"]
        assert after < before / 3
        await c.aclose()
    async with running(tmp_path, appendonly=True) as s:
        c = client_for(s)
        assert await c.get("n") == b"500" and await c.llen("l") == 200
        assert await c.get("during") == b"rewrite" and await c.get("after") == b"rewrite"
        await c.aclose()


def test_snapshot_atomic_write_keeps_old_file_on_failure(tmp_path, monkeypatch):
    path = tmp_path / "dump.mdb"
    snapshot.write_atomic(path, b"OLD")

    def boom(*a):
        raise OSError("disk full")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        snapshot.write_atomic(path, b"NEW")
    assert path.read_bytes() == b"OLD"


def test_aof_rewrite_output_is_minimal():
    ks = Keyspace()
    ks.store(b"n", b"500")
    out = AppendOnlyFile.minimal_commands(ks)
    assert out == b"*3\r\n$3\r\nSET\r\n$1\r\nn\r\n$3\r\n500\r\n"


async def test_writes_during_bgsave_stay_dirty(tmp_path):
    """Regression: dirty counter went negative after BGSAVE."""
    async with running(tmp_path) as s:
        c = client_for(s)
        await c.set("a", "1")
        await c.set("b", "2")
        assert s.start_bgsave()
        await c.set("during", "x")       # not part of the snapshot payload
        for _ in range(100):
            if not s.persistence.bgsave_in_progress:
                break
            await asyncio.sleep(0.01)
        assert s.persistence.dirty == 1
        await c.aclose()
