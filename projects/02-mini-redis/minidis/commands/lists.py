from __future__ import annotations

from collections import deque

from ..keyspace import ELEMENT_OVERHEAD
from ..protocol import RespError
from . import Context, command, to_int


def _push(ctx: Context, args, left: bool) -> int:
    key = args[1]
    lst = ctx.ks.lookup_typed(key, deque, create=deque)
    for v in args[2:]:
        (lst.appendleft if left else lst.append)(v)
    ctx.ks.adjust_size(key, sum(len(v) + ELEMENT_OVERHEAD for v in args[2:]))
    return len(lst)


@command("LPUSH", -3, write=True)
def lpush(ctx, args):
    return _push(ctx, args, left=True)


@command("RPUSH", -3, write=True)
def rpush(ctx, args):
    return _push(ctx, args, left=False)


def _pop(ctx: Context, args, left: bool):
    key = args[1]
    lst = ctx.ks.lookup_typed(key, deque)
    count = to_int(args[2]) if len(args) > 2 else None
    if lst is None:
        ctx.rewrite()
        return None
    n = 1 if count is None else max(count, 0)
    out = []
    while lst and len(out) < n:
        v = lst.popleft() if left else lst.pop()
        ctx.ks.adjust_size(key, -(len(v) + ELEMENT_OVERHEAD))
        out.append(v)
    ctx.ks.delete_if_empty(key, lst)
    if count is None:
        return out[0] if out else None
    return out


@command("LPOP", -2, write=True, may_grow=False)
def lpop(ctx, args):
    return _pop(ctx, args, left=True)


@command("RPOP", -2, write=True, may_grow=False)
def rpop(ctx, args):
    return _pop(ctx, args, left=False)


@command("LLEN", 2)
def llen(ctx, args):
    lst = ctx.ks.lookup_typed(args[1], deque)
    return len(lst) if lst else 0


def _norm_range(start: int, stop: int, n: int) -> tuple[int, int]:
    if start < 0:
        start = max(n + start, 0)
    if stop < 0:
        stop = n + stop
    stop = min(stop, n - 1)
    return start, stop


@command("LRANGE", 4)
def lrange(ctx, args):
    lst = ctx.ks.lookup_typed(args[1], deque)
    if not lst:
        return []
    start, stop = _norm_range(to_int(args[2]), to_int(args[3]), len(lst))
    if start > stop:
        return []
    # deque indexing is O(n) in the middle; slicing via list() keeps the code simple.
    return list(lst)[start:stop + 1]


@command("LINDEX", 3)
def lindex(ctx, args):
    lst = ctx.ks.lookup_typed(args[1], deque)
    if not lst:
        return None
    i = to_int(args[2])
    try:
        return lst[i]
    except IndexError:
        return None


@command("LSET", 4, write=True)
def lset(ctx, args):
    lst = ctx.ks.lookup_typed(args[1], deque)
    if lst is None:
        raise RespError("ERR no such key")
    i = to_int(args[2])
    try:
        old = lst[i]
        lst[i] = args[3]
    except IndexError:
        raise RespError("ERR index out of range") from None
    ctx.ks.adjust_size(args[1], len(args[3]) - len(old))
    from ..protocol import OK
    return OK
