from __future__ import annotations

from ..keyspace import WRONGTYPE
from ..protocol import OK, RespError
from . import Context, command, to_int


def _get_str(ctx: Context, key: bytes) -> bytes | None:
    value = ctx.ks.lookup(key)
    if value is not None and not isinstance(value, bytes):
        raise WRONGTYPE
    return value


@command("GET", 2)
def get(ctx: Context, args):
    return _get_str(ctx, args[1])


@command("SET", -3, write=True)
def set_(ctx: Context, args):
    """SET key value [NX|XX] [EX s|PX ms|EXAT s|PXAT ms|KEEPTTL] [GET]"""
    key, value = args[1], args[2]
    nx = xx = keepttl = want_get = False
    expire_at: int | None = None
    i = 3
    while i < len(args):
        opt = args[i].upper()
        if opt == b"NX":
            nx = True
        elif opt == b"XX":
            xx = True
        elif opt == b"KEEPTTL":
            keepttl = True
        elif opt == b"GET":
            want_get = True
        elif opt in (b"EX", b"PX", b"EXAT", b"PXAT") and i + 1 < len(args):
            n = to_int(args[i + 1])
            if n <= 0:
                raise RespError("ERR invalid expire time in 'set' command")
            now = ctx.ks.now_ms()
            expire_at = {b"EX": now + n * 1000, b"PX": now + n, b"EXAT": n * 1000, b"PXAT": n}[opt]
            i += 1
        else:
            raise RespError("ERR syntax error")
        i += 1
    if nx and xx:
        raise RespError("ERR syntax error")
    old = _get_str(ctx, key) if want_get else None
    exists = ctx.ks.exists(key)
    if (nx and exists) or (xx and not exists):
        ctx.rewrite()  # nothing changed -> nothing to propagate
        return old if want_get else None
    ctx.ks.store(key, value, keep_ttl=keepttl)
    if expire_at is not None:
        ctx.ks.set_expire_at(key, expire_at)
        # Propagate ABSOLUTE expiry. Replaying "SET k v EX 60" from the AOF tomorrow would
        # give the key a fresh 60s; PEXPIREAT keeps the original deadline.
        ctx.rewrite([b"SET", key, value], [b"PEXPIREAT", key, str(expire_at).encode()])
    elif keepttl:
        ctx.rewrite([b"SET", key, value, b"KEEPTTL"])
    else:
        ctx.rewrite([b"SET", key, value])
    return old if want_get else OK


@command("SETNX", 3, write=True)
def setnx(ctx: Context, args):
    if ctx.ks.exists(args[1]):
        ctx.rewrite()
        return 0
    ctx.ks.store(args[1], args[2])
    return 1


@command("MGET", -2)
def mget(ctx: Context, args):
    out = []
    for k in args[1:]:
        v = ctx.ks.lookup(k)
        out.append(v if isinstance(v, bytes) else None)  # wrong type -> nil, as in Redis
    return out


@command("MSET", -3, write=True)
def mset(ctx: Context, args):
    if len(args) % 2 != 1:
        raise RespError("ERR wrong number of arguments for 'mset' command")
    for i in range(1, len(args), 2):
        ctx.ks.store(args[i], args[i + 1])
    return OK


def _incr(ctx: Context, key: bytes, delta: int) -> int:
    current = _get_str(ctx, key)
    n = to_int(current) if current is not None else 0
    n += delta
    if not -(2**63) <= n < 2**63:
        raise RespError("ERR increment or decrement would overflow")
    ctx.ks.store(key, str(n).encode(), keep_ttl=True)  # INCR keeps the TTL
    return n


@command("INCR", 2, write=True)
def incr(ctx, args):
    return _incr(ctx, args[1], 1)


@command("DECR", 2, write=True)
def decr(ctx, args):
    return _incr(ctx, args[1], -1)


@command("INCRBY", 3, write=True)
def incrby(ctx, args):
    return _incr(ctx, args[1], to_int(args[2]))


@command("DECRBY", 3, write=True)
def decrby(ctx, args):
    return _incr(ctx, args[1], -to_int(args[2]))


@command("APPEND", 3, write=True)
def append(ctx, args):
    current = _get_str(ctx, args[1]) or b""
    new = current + args[2]
    ctx.ks.store(args[1], new, keep_ttl=True)
    return len(new)


@command("STRLEN", 2)
def strlen(ctx, args):
    v = _get_str(ctx, args[1])
    return len(v) if v else 0


@command("GETDEL", 2, write=True, may_grow=False)
def getdel(ctx, args):
    v = _get_str(ctx, args[1])
    if v is not None:
        ctx.ks.delete(args[1])
        ctx.rewrite([b"DEL", args[1]])
    else:
        ctx.rewrite()
    return v
