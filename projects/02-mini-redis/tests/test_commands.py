"""Command semantics, exercised through the official redis-py client (proves wire compatibility)."""
import asyncio

import pytest
import redis.asyncio as R
from redis.exceptions import ResponseError

from .conftest import client_for


async def test_strings(r):
    assert await r.set("k", "v") is True
    assert await r.get("k") == b"v"
    assert await r.append("k", "w") == 2
    assert await r.strlen("k") == 2
    assert await r.incr("n") == 1 and await r.incrby("n", 10) == 11 and await r.decr("n") == 10
    assert await r.mset({"a": "1", "b": "2"}) and await r.mget("a", "b", "zz") == [b"1", b"2", None]
    assert await r.getdel("a") == b"1" and await r.exists("a") == 0
    with pytest.raises(ResponseError, match="not an integer"):
        await r.incr("k")


async def test_set_options(r):
    assert await r.set("k", "1", nx=True) is True
    assert await r.set("k", "2", nx=True) is None
    assert await r.set("missing", "x", xx=True) is None
    assert await r.set("k", "3", xx=True, get=True) == b"1"
    await r.set("t", "v", ex=100)
    assert 99 <= await r.ttl("t") <= 100
    await r.set("t", "v2", keepttl=True)
    assert await r.ttl("t") > 0
    await r.set("t", "v3")  # plain SET clears TTL
    assert await r.ttl("t") == -1


async def test_ttl_semantics(r):
    assert await r.ttl("nope") == -2
    await r.set("k", "v")
    assert await r.ttl("k") == -1
    assert await r.pexpire("k", 50) is True
    assert 0 < await r.pttl("k") <= 50
    await asyncio.sleep(0.08)
    assert await r.get("k") is None and await r.ttl("k") == -2
    await r.set("p", "v", ex=10)
    assert await r.persist("p") is True and await r.ttl("p") == -1
    await r.set("gone", "v")
    assert await r.expire("gone", -1) is True and await r.exists("gone") == 0  # past expiry = delete


async def test_lists(r):
    assert await r.rpush("l", "a", "b", "c") == 3
    assert await r.lpush("l", "z") == 4
    assert await r.lrange("l", 0, -1) == [b"z", b"a", b"b", b"c"]
    assert await r.lrange("l", -2, 100) == [b"b", b"c"]
    assert await r.lindex("l", -1) == b"c"
    assert await r.lpop("l") == b"z" and await r.rpop("l") == b"c"
    assert await r.lpop("l", 5) == [b"a", b"b"]
    assert await r.exists("l") == 0  # empty list is deleted


async def test_sets(r):
    assert await r.sadd("s", "a", "b", "a") == 2
    assert await r.sismember("s", "a") == 1 and await r.scard("s") == 2
    await r.sadd("t", "b", "c")
    assert await r.sinter("s", "t") == {b"b"}
    assert await r.sunion("s", "t") == {b"a", b"b", b"c"}
    assert await r.sdiff("s", "t") == {b"a"}
    assert await r.srem("s", "a", "b") == 2 and await r.exists("s") == 0


async def test_hashes(r):
    assert await r.hset("h", mapping={"f1": "v1", "f2": "v2"}) == 2
    assert await r.hget("h", "f1") == b"v1"
    assert await r.hgetall("h") == {b"f1": b"v1", b"f2": b"v2"}
    assert await r.hincrby("h", "n", 5) == 5
    assert await r.hlen("h") == 3 and await r.hexists("h", "f2") == 1
    assert await r.hdel("h", "f1", "f2", "n") == 3 and await r.exists("h") == 0


async def test_resp3_client(server):
    c = client_for(server, proto=3)
    await c.hset("h", "f", "v")
    await c.sadd("s", "x")
    assert await c.hgetall("h") == {b"f": b"v"}
    assert await c.smembers("s") == {b"x"}
    await c.aclose()


async def test_wrongtype_and_errors(r):
    await r.set("str", "v")
    with pytest.raises(ResponseError, match="WRONGTYPE"):
        await r.lpush("str", "x")
    with pytest.raises(ResponseError, match="wrong number of arguments"):
        await r.execute_command("GET")
    with pytest.raises(ResponseError, match="unknown command"):
        await r.execute_command("NOPE")
    assert await r.type("str") == b"string"
    await r.rpush("l", "x")
    assert await r.type("l") == b"list" and await r.type("none") == b"none"


async def test_keys_scan_dbsize(r):
    for i in range(25):
        await r.set(f"user:{i}", i)
    await r.set("other", 1)
    assert len(await r.keys("user:*")) == 25
    seen = set()
    cursor = 0
    while True:
        cursor, batch = await r.scan(cursor, match="user:*", count=7)
        seen.update(batch)
        if cursor == 0:
            break
    assert len(seen) == 25
    assert await r.dbsize() == 26


async def test_info_and_memory(r):
    await r.set("k", "x" * 1000)
    info = await r.info("memory")
    assert info["used_memory"] >= 1000
    assert await r.memory_usage("k") >= 1000
    assert (await r.info("replication"))["role"] == "master"


async def test_integer_parsing_is_strict_like_redis(r):
    for bad in [" 5", "5 ", "+5", "1_000", "05", "-0", "5.0", "", "9223372036854775808"]:
        await r.set("n", bad)
        with pytest.raises(ResponseError, match="not an integer"):
            await r.incr("n")
    await r.set("n", "-7")
    assert await r.incr("n") == -6
    with pytest.raises(ResponseError):
        await r.expire("n", "+10")
