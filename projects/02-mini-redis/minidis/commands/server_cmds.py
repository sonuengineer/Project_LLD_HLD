"""Server/admin commands. Many need the Server object (persistence, replication, config)."""
from __future__ import annotations

import time

from ..keyspace import EvictionPolicy
from ..protocol import OK, RespError, SimpleString
from . import Context, command, to_int


@command("PING", -1)
def ping(ctx, args):
    return args[1] if len(args) > 1 else SimpleString("PONG")


@command("ECHO", 2)
def echo(ctx, args):
    return args[1]


@command("SELECT", 2)
def select(ctx, args):
    if args[1] != b"0":
        raise RespError("ERR DB index is out of range (minidis supports only db 0)")
    return OK


@command("HELLO", -1)
def hello(ctx: Context, args):
    """HELLO [protover [SETNAME name]] -- switches this connection to RESP2 or RESP3."""
    proto = ctx.client.proto if ctx.client else 2
    if len(args) > 1:
        try:
            proto = int(args[1])
        except ValueError:
            raise RespError("ERR Protocol version is not an integer or out of range") from None
        if proto not in (2, 3):
            raise RespError("NOPROTO unsupported protocol version")
    i = 2
    while i < len(args):
        if args[i].upper() == b"SETNAME" and i + 1 < len(args) and ctx.client:
            ctx.client.name = args[i + 1].decode("utf-8", "replace")
            i += 2
        else:
            raise RespError("ERR syntax error in HELLO option")
    if ctx.client:
        ctx.client.proto = proto
    return {b"server": b"minidis", b"version": b"1.0.0", b"proto": proto,
            b"id": ctx.client.id if ctx.client else 0, b"mode": b"standalone",
            b"role": b"replica" if ctx.server.replica_link else b"master", b"modules": []}


@command("CLIENT", -2)
def client(ctx: Context, args):
    sub = args[1].upper()
    if sub in (b"SETINFO", b"SETNAME"):
        if sub == b"SETNAME" and ctx.client and len(args) > 2:
            ctx.client.name = args[2].decode("utf-8", "replace")
        return OK
    if sub == b"GETNAME":
        return ctx.client.name.encode() if ctx.client and ctx.client.name else None
    if sub == b"ID":
        return ctx.client.id if ctx.client else 0
    if sub == b"LIST":
        lines = [f"id={c.id} addr={c.addr} name={c.name or ''} cmds={c.commands} replica={int(c.is_replica)}"
                 for c in ctx.server.clients.values()]
        return ("\n".join(lines) + "\n").encode()
    raise RespError("ERR unknown CLIENT subcommand")


@command("COMMAND", -1)
def command_(ctx, args):
    # redis-cli asks for COMMAND DOCS on start; an empty reply is acceptable to it.
    if len(args) > 1 and args[1].upper() == b"COUNT":
        from . import REGISTRY
        return len(REGISTRY)
    return []


@command("DEBUG", -2)
def debug(ctx, args):
    sub = args[1].upper()
    if sub == b"SLEEP" and len(args) == 3:
        # Deliberately blocking: demonstrates that one slow command stalls EVERY client
        # (single-threaded execution), the same reason KEYS * is dangerous in Redis.
        time.sleep(float(args[2]))
        return OK
    raise RespError("ERR unsupported DEBUG subcommand")


@command("MEMORY", -2)
def memory(ctx, args):
    sub = args[1].upper()
    if sub == b"USAGE" and len(args) >= 3:
        return ctx.ks.entry_memory(args[2])
    if sub == b"STATS":
        return [b"used_memory", ctx.ks.used_memory, b"keys.count", len(ctx.ks)]
    raise RespError("ERR unknown MEMORY subcommand")


@command("INFO", -1)
def info(ctx: Context, args):
    section = args[1].decode().lower() if len(args) > 1 else "all"
    return ctx.server.info(section).encode()


@command("SAVE", 1)
def save(ctx: Context, args):
    ctx.server.save_snapshot_sync()
    return OK


@command("BGSAVE", -1)
def bgsave(ctx: Context, args):
    # Clients may send "BGSAVE SCHEDULE" (redis-py does); we accept and start immediately.
    if not ctx.server.start_bgsave():
        raise RespError("ERR Background save already in progress")
    return SimpleString("Background saving started")


@command("LASTSAVE", 1)
def lastsave(ctx: Context, args):
    return int(ctx.server.persistence.last_save_time)


@command("BGREWRITEAOF", 1)
def bgrewriteaof(ctx: Context, args):
    if ctx.server.aof is None:
        raise RespError("ERR appendonly is disabled")
    if not ctx.server.start_aof_rewrite():
        raise RespError("ERR Background append only file rewriting already in progress")
    return SimpleString("Background append only file rewriting started")


_CONFIG_KEYS = ("maxmemory", "maxmemory-policy", "appendfsync", "appendonly", "save", "dir", "port")


@command("CONFIG", -2)
def config(ctx: Context, args):
    cfg = ctx.server.config
    sub = args[1].upper()
    if sub == b"GET" and len(args) == 3:
        import fnmatch
        pat = args[2].decode().lower()
        out = []
        for k in _CONFIG_KEYS:
            if fnmatch.fnmatchcase(k, pat):
                out += [k.encode(), str(cfg.get(k)).encode()]
        return out
    if sub == b"SET" and len(args) == 4:
        k, v = args[2].decode().lower(), args[3].decode()
        if k == "maxmemory":
            cfg.maxmemory = to_int(args[3])
        elif k == "maxmemory-policy":
            try:
                cfg.maxmemory_policy = EvictionPolicy(v)
            except ValueError:
                raise RespError(f"ERR invalid maxmemory-policy {v!r}") from None
        elif k == "appendfsync":
            if v not in ("always", "everysec", "no"):
                raise RespError("ERR invalid appendfsync")
            cfg.appendfsync = v
            if ctx.server.aof:
                ctx.server.aof.fsync_policy = v
        else:
            raise RespError(f"ERR CONFIG SET not supported for {k!r}")
        return OK
    raise RespError("ERR unknown CONFIG subcommand or wrong arguments")


@command("REPLICAOF", 3)
def replicaof(ctx: Context, args):
    if args[1].upper() == b"NO" and args[2].upper() == b"ONE":
        ctx.server.promote_to_master()
        return OK
    ctx.server.become_replica_of(args[1].decode(), to_int(args[2]))
    return OK


@command("SLAVEOF", 3)
def slaveof(ctx, args):
    return replicaof(ctx, args)


@command("REPLCONF", -2)
def replconf(ctx, args):
    return OK  # ACKs are consumed in the replica session loop; anything else is accepted
