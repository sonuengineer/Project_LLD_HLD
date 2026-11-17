"""RESP2 (REdis Serialization Protocol) parser and encoder.

Wire format recap:
  +OK\r\n                  simple string
  -ERR message\r\n         error
  :42\r\n                  integer
  $5\r\nhello\r\n          bulk string ($-1\r\n = null)
  *2\r\n$3\r\nGET\r\n$1\r\nk\r\n   array (clients always send commands as arrays of bulk strings)

The parser is INCREMENTAL: TCP is a byte stream, so one recv() may contain half a command or
ten pipelined commands. We only consume bytes once a full command is available.
"""
from __future__ import annotations

from typing import Any

MAX_BULK_LEN = 512 * 1024 * 1024    # same as Redis proto-max-bulk-len default
MAX_MULTIBULK_LEN = 1024 * 1024
MAX_INLINE_LEN = 64 * 1024


class ProtocolError(Exception):
    """Malformed input: the connection must be closed (stream can't be resynchronised)."""


class SimpleString(str):
    """Encoded as +value (no binary safety, used for OK / PONG / type names)."""


class RespError(Exception):
    """A command-level error, encoded as -PREFIX message. The connection stays open."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message if message.split(" ", 1)[0].isupper() else "ERR " + message


OK = SimpleString("OK")


class NullArray:
    """*-1 (e.g. timed-out blocking pop); distinct from null bulk."""


NULL_ARRAY = NullArray()


class RespSet(list):
    """A reply that is semantically a set: RESP3 '~' type, plain array in RESP2."""


# RESP2 vs RESP3 (negotiated per connection with HELLO):
#   RESP2 has only 5 types, so a hash reply is a flat array [f1, v1, f2, v2] and the
#   client must know to pair them up. RESP3 adds typed replies: map '%', set '~',
#   null '_', boolean '#', double ','. Commands here return Python types (dict, RespSet,
#   None ...) and the encoder picks the wire form for the client's protocol version.


class Parser:
    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> None:
        self._buf += data

    @property
    def pending(self) -> int:
        return len(self._buf)

    def get_command(self) -> list[bytes] | None:
        """Return one complete command (list of args) or None if more bytes are needed."""
        if not self._buf:
            return None
        if self._buf[0:1] == b"*":
            return self._parse_multibulk()
        return self._parse_inline()

    def _parse_inline(self) -> list[bytes] | None:
        # "PING\r\n" typed into telnet. Useful for debugging, not used by real clients.
        end = self._buf.find(b"\n")
        if end == -1:
            if len(self._buf) > MAX_INLINE_LEN:
                raise ProtocolError("too big inline request")
            return None
        line = bytes(self._buf[:end]).rstrip(b"\r")
        del self._buf[: end + 1]
        parts = line.split()
        return parts if parts else self.get_command()

    def _parse_multibulk(self) -> list[bytes] | None:
        buf = self._buf
        pos = 0
        line_end = buf.find(b"\r\n", pos)
        if line_end == -1:
            return None
        try:
            count = int(buf[1:line_end])
        except ValueError:
            raise ProtocolError("invalid multibulk length") from None
        if count > MAX_MULTIBULK_LEN:
            raise ProtocolError("invalid multibulk length")
        pos = line_end + 2
        args: list[bytes] = []
        for _ in range(count):
            if pos >= len(buf):
                return None
            if buf[pos:pos + 1] != b"$":
                raise ProtocolError(f"expected '$', got {bytes(buf[pos:pos + 1])!r}")
            line_end = buf.find(b"\r\n", pos)
            if line_end == -1:
                return None
            try:
                length = int(buf[pos + 1:line_end])
            except ValueError:
                raise ProtocolError("invalid bulk length") from None
            if length < 0 or length > MAX_BULK_LEN:
                raise ProtocolError("invalid bulk length")
            start = line_end + 2
            if len(buf) < start + length + 2:
                return None  # payload not fully arrived yet
            args.append(bytes(buf[start:start + length]))
            pos = start + length + 2
        del buf[:pos]  # consume only now that the whole command is present
        return args


def encode(value: Any, proto: int = 2) -> bytes:
    if value is None:
        return b"_\r\n" if proto == 3 else b"$-1\r\n"
    if isinstance(value, SimpleString):
        return b"+" + value.encode() + b"\r\n"
    if isinstance(value, RespError):
        return b"-" + value.message.encode() + b"\r\n"
    if isinstance(value, bool):
        if proto == 3:
            return b"#t\r\n" if value else b"#f\r\n"
        return b":1\r\n" if value else b":0\r\n"
    if isinstance(value, int):
        return b":" + str(value).encode() + b"\r\n"
    if isinstance(value, (bytes, bytearray)):
        return b"$" + str(len(value)).encode() + b"\r\n" + bytes(value) + b"\r\n"
    if isinstance(value, str):
        return encode(value.encode(), proto)
    if isinstance(value, NullArray):
        return b"_\r\n" if proto == 3 else b"*-1\r\n"
    if isinstance(value, dict):
        if proto == 3:
            return (b"%" + str(len(value)).encode() + b"\r\n"
                    + b"".join(encode(k, proto) + encode(v, proto) for k, v in value.items()))
        return encode([x for kv in value.items() for x in kv], proto)
    if isinstance(value, RespSet) and proto == 3:
        return b"~" + str(len(value)).encode() + b"\r\n" + b"".join(encode(v, proto) for v in value)
    if isinstance(value, (list, tuple)):
        return b"*" + str(len(value)).encode() + b"\r\n" + b"".join(encode(v, proto) for v in value)
    if isinstance(value, float):
        if proto == 3:
            return b"," + repr(value).encode() + b"\r\n"
        return encode(repr(value).encode(), proto)
    raise TypeError(f"cannot encode {type(value)}")


def encode_command(args: list[bytes] | tuple[bytes, ...]) -> bytes:
    """Commands are always arrays of bulk strings (used for AOF and replication stream)."""
    out = [b"*", str(len(args)).encode(), b"\r\n"]
    for a in args:
        out += [b"$", str(len(a)).encode(), b"\r\n", a, b"\r\n"]
    return b"".join(out)
