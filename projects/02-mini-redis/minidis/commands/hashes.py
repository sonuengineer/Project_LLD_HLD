from __future__ import annotations

from ..keyspace import ELEMENT_OVERHEAD
from ..protocol import RespError
from . import Context, command, to_int


@command("HSET", -4, write=True)
def hset(ctx: Context, args):
    if len(args) % 2 != 0:
        raise RespError("ERR wrong number of arguments for 'hset' command")
    h = ctx.ks.lookup_typed(args[1], dict, create=dict)
    added = 0
    for i in range(2, len(args), 2):
        f, v = args[i], args[i + 1]
        old = h.get(f)
        if old is None:
            added += 1
            ctx.ks.adjust_size(args[1], len(f) + len(v) + 2 * ELEMENT_OVERHEAD)
        else:
            ctx.ks.adjust_size(args[1], len(v) - len(old))
        h[f] = v
    return added


@command("HGET", 3)
def hget(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict)
    return h.get(args[2]) if h else None


@command("HDEL", -3, write=True, may_grow=False)
def hdel(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict)
    if not h:
        return 0
    removed = 0
    for f in args[2:]:
        v = h.pop(f, None)
        if v is not None:
            removed += 1
            ctx.ks.adjust_size(args[1], -(len(f) + len(v) + 2 * ELEMENT_OVERHEAD))
    ctx.ks.delete_if_empty(args[1], h)
    return removed


@command("HGETALL", 2)
def hgetall(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict)
    return dict(h or {})  # map in RESP3, flat [f, v, ...] array in RESP2


@command("HEXISTS", 3)
def hexists(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict)
    return int(bool(h) and args[2] in h)


@command("HLEN", 2)
def hlen(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict)
    return len(h) if h else 0


@command("HKEYS", 2)
def hkeys(ctx, args):
    return list((ctx.ks.lookup_typed(args[1], dict) or {}).keys())


@command("HVALS", 2)
def hvals(ctx, args):
    return list((ctx.ks.lookup_typed(args[1], dict) or {}).values())


@command("HMGET", -3)
def hmget(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict) or {}
    return [h.get(f) for f in args[2:]]


@command("HINCRBY", 4, write=True)
def hincrby(ctx, args):
    h = ctx.ks.lookup_typed(args[1], dict, create=dict)
    old = h.get(args[2])
    try:
        current = to_int(old) if old is not None else 0
    except RespError:
        raise RespError("ERR hash value is not an integer") from None
    n = current + to_int(args[3])
    new = str(n).encode()
    h[args[2]] = new
    ctx.ks.adjust_size(args[1], len(new) - len(old) if old is not None
                       else len(args[2]) + len(new) + 2 * ELEMENT_OVERHEAD)
    return n
