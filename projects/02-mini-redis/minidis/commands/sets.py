from __future__ import annotations

from ..keyspace import ELEMENT_OVERHEAD
from ..protocol import RespSet
from . import Context, command


@command("SADD", -3, write=True)
def sadd(ctx: Context, args):
    s = ctx.ks.lookup_typed(args[1], set, create=set)
    added = 0
    for m in args[2:]:
        if m not in s:
            s.add(m)
            added += 1
            ctx.ks.adjust_size(args[1], len(m) + ELEMENT_OVERHEAD)
    return added


@command("SREM", -3, write=True, may_grow=False)
def srem(ctx: Context, args):
    s = ctx.ks.lookup_typed(args[1], set)
    if not s:
        return 0
    removed = 0
    for m in args[2:]:
        if m in s:
            s.discard(m)
            removed += 1
            ctx.ks.adjust_size(args[1], -(len(m) + ELEMENT_OVERHEAD))
    ctx.ks.delete_if_empty(args[1], s)
    return removed


@command("SMEMBERS", 2)
def smembers(ctx, args):
    s = ctx.ks.lookup_typed(args[1], set)
    return RespSet(sorted(s) if s else [])  # sorted only to make output deterministic for humans/tests


@command("SISMEMBER", 3)
def sismember(ctx, args):
    s = ctx.ks.lookup_typed(args[1], set)
    return int(bool(s) and args[2] in s)


@command("SCARD", 2)
def scard(ctx, args):
    s = ctx.ks.lookup_typed(args[1], set)
    return len(s) if s else 0


def _sets(ctx, keys):
    return [ctx.ks.lookup_typed(k, set) or set() for k in keys]


@command("SINTER", -2)
def sinter(ctx, args):
    sets = _sets(ctx, args[1:])
    return RespSet(sorted(set.intersection(*sets)) if sets else [])


@command("SUNION", -2)
def sunion(ctx, args):
    return RespSet(sorted(set.union(*_sets(ctx, args[1:]))))


@command("SDIFF", -2)
def sdiff(ctx, args):
    first, *rest = _sets(ctx, args[1:])
    return RespSet(sorted(first.difference(*rest)))
