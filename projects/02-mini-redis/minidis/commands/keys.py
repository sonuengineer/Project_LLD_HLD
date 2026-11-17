from __future__ import annotations

import fnmatch

from ..keyspace import type_name
from ..protocol import OK, RespError, SimpleString
from . import Context, command, to_int


@command("DEL", -2, write=True, may_grow=False)
def delete(ctx: Context, args):
    return sum(ctx.ks.delete(k) for k in args[1:])


@command("UNLINK", -2, write=True, may_grow=False)
def unlink(ctx: Context, args):
    return delete(ctx, args)


@command("EXISTS", -2)
def exists(ctx: Context, args):
    return sum(ctx.ks.exists(k) for k in args[1:])  # counts duplicates, like Redis


@command("TYPE", 2)
def type_(ctx: Context, args):
    v = ctx.ks.lookup(args[1], touch=False)
    return SimpleString("none" if v is None else type_name(v))


def _expire_generic(ctx: Context, key: bytes, when_ms: int) -> int:
    if not ctx.ks.exists(key):
        ctx.rewrite()
        return 0
    if when_ms <= ctx.ks.now_ms():
        # Expiry in the past = delete now (and propagate DEL, not a past PEXPIREAT).
        ctx.ks.delete(key)
        ctx.rewrite([b"DEL", key])
        return 1
    ctx.ks.set_expire_at(key, when_ms)
    ctx.rewrite([b"PEXPIREAT", key, str(when_ms).encode()])
    return 1


@command("EXPIRE", 3, write=True, may_grow=False)
def expire(ctx, args):
    return _expire_generic(ctx, args[1], ctx.ks.now_ms() + to_int(args[2]) * 1000)


@command("PEXPIRE", 3, write=True, may_grow=False)
def pexpire(ctx, args):
    return _expire_generic(ctx, args[1], ctx.ks.now_ms() + to_int(args[2]))


@command("EXPIREAT", 3, write=True, may_grow=False)
def expireat(ctx, args):
    return _expire_generic(ctx, args[1], to_int(args[2]) * 1000)


@command("PEXPIREAT", 3, write=True, may_grow=False)
def pexpireat(ctx, args):
    return _expire_generic(ctx, args[1], to_int(args[2]))


@command("TTL", 2)
def ttl(ctx, args):
    p = ctx.ks.pttl(args[1])
    return p if p < 0 else (p + 500) // 1000  # Redis rounds to nearest second


@command("PTTL", 2)
def pttl(ctx, args):
    return ctx.ks.pttl(args[1])


@command("PERSIST", 2, write=True, may_grow=False)
def persist(ctx, args):
    if not ctx.ks.exists(args[1]):
        return 0
    return int(ctx.ks.persist(args[1]))


@command("KEYS", 2)
def keys(ctx, args):
    """O(N) over the whole keyspace and blocks the server while it runs -- same warning as Redis:
    never use KEYS in production; use SCAN."""
    pattern = args[1].decode("utf-8", "replace")
    return [k for k in list(ctx.ks.data) if ctx.ks.exists(k)
            and fnmatch.fnmatchcase(k.decode("utf-8", "replace"), pattern)]


@command("SCAN", -2)
def scan(ctx, args):
    """Cursor-based iteration in small batches so no single call blocks for long.
    Cursor = position in a snapshot of key order. Simplified: keys added/removed during a
    scan may be missed or repeated (Redis has the same 'may repeat' caveat)."""
    cursor = to_int(args[1])
    count, pattern = 10, None
    i = 2
    while i + 1 < len(args):
        opt = args[i].upper()
        if opt == b"COUNT":
            count = max(to_int(args[i + 1]), 1)
        elif opt == b"MATCH":
            pattern = args[i + 1].decode("utf-8", "replace")
        else:
            raise RespError("ERR syntax error")
        i += 2
    all_keys = list(ctx.ks.data)
    batch = all_keys[cursor:cursor + count]
    nxt = cursor + count if cursor + count < len(all_keys) else 0
    out = [k for k in batch if ctx.ks.exists(k)
           and (pattern is None or fnmatch.fnmatchcase(k.decode("utf-8", "replace"), pattern))]
    return [str(nxt).encode(), out]


@command("DBSIZE", 1)
def dbsize(ctx, args):
    return len(ctx.ks)


@command("FLUSHDB", -1, write=True, may_grow=False)
def flushdb(ctx, args):
    ctx.ks.flush()
    ctx.rewrite([b"FLUSHDB"])
    return OK


@command("FLUSHALL", -1, write=True, may_grow=False)
def flushall(ctx, args):
    return flushdb(ctx, args)


@command("RENAME", 3, write=True)
def rename(ctx, args):
    src, dst = args[1], args[2]
    value = ctx.ks.lookup(src)
    if value is None:
        raise RespError("ERR no such key")
    when = ctx.ks.expires.get(src)
    ctx.ks.delete(src)
    ctx.ks.store(dst, value)
    if when is not None:
        ctx.ks.set_expire_at(dst, when)
    return OK
