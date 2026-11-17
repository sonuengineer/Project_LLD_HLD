"""Command registry.

Every handler is a plain (synchronous) function: def handler(ctx, args) -> reply.
Because handlers never `await`, the asyncio loop can't switch to another client in the
middle of a command. That gives us Redis' guarantee: each command is atomic.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from ..protocol import RespError

if TYPE_CHECKING:
    from ..keyspace import Keyspace
    from ..server import ClientState, Server


@dataclass
class Command:
    name: str
    handler: Callable[["Context", list[bytes]], Any]
    arity: int          # >0 exact arg count incl. name; <0 means "at least abs(arity)"
    write: bool         # write commands: rejected on replicas, propagated to AOF/replicas
    may_grow: bool = True   # only commands that can GROW memory are refused with OOM (Redis 'denyoom');
                            # DEL, pops, EXPIRE ... must keep working so users can free memory


@dataclass
class Context:
    server: "Server"
    ks: "Keyspace"
    client: "ClientState | None"
    # What gets written to AOF / sent to replicas. None => the original argv.
    # Handlers rewrite relative TTLs into absolute PEXPIREAT here, or set [] to skip.
    propagate: list[list[bytes]] | None = None
    dirty: int = 0

    def rewrite(self, *cmds: list[bytes]) -> None:
        self.propagate = list(cmds)


REGISTRY: dict[str, Command] = {}


def command(name: str, arity: int, write: bool = False, may_grow: bool | None = None):
    def deco(fn):
        REGISTRY[name.upper()] = Command(name.upper(), fn, arity, write, write if may_grow is None else may_grow)
        return fn
    return deco


def check_arity(cmd: Command, args: list[bytes]) -> None:
    n = len(args)
    if (cmd.arity > 0 and n != cmd.arity) or (cmd.arity < 0 and n < -cmd.arity):
        raise RespError(f"ERR wrong number of arguments for '{cmd.name.lower()}' command")


_INT = __import__("re").compile(rb"-?(0|[1-9][0-9]*)")


def to_int(raw: bytes) -> int:
    """Strict like Redis' string2ll: optional '-', digits, no leading zeros, no spaces, no '+',
    no '_' (Python's int() would accept ' 5 ', '+5' and '1_000')."""
    if not _INT.fullmatch(raw) or raw == b"-0":
        raise RespError("ERR value is not an integer or out of range")
    n = int(raw)
    if not -(2**63) <= n < 2**63:
        raise RespError("ERR value is not an integer or out of range")
    return n


# Import modules so their @command decorators register handlers.
from . import hashes, keys, lists, server_cmds, sets, strings  # noqa: E402,F401
