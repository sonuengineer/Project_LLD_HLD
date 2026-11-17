"""Point-in-time snapshot (our "RDB").

File layout:
    MAGIC (8 bytes)  b"MINIDIS\\x01"
    record*          type(1) expire_ms(int64, -1 = none) key(len u32 + bytes) payload
    END (1 byte)     0xFF
    CRC32 (u32)      over everything before it -> detects truncation / bit rot

Payload per type:
    S string : len u32 + bytes
    L list   : count u32 + (len u32 + bytes)*
    T set    : count u32 + (len u32 + bytes)*
    H hash   : count u32 + (flen u32 + f + vlen u32 + v)*

Written to a temp file, fsync'd, then os.replace()'d over the old file: a crash mid-write
leaves the previous snapshot intact (atomic rename).
"""
from __future__ import annotations

import os
import struct
import zlib
from collections import deque
from pathlib import Path

from ..keyspace import Keyspace

MAGIC = b"MINIDIS\x01"
END = 0xFF
_U32 = struct.Struct(">I")
_I64 = struct.Struct(">q")


class CorruptSnapshot(Exception):
    pass


def _blob(b: bytes) -> bytes:
    return _U32.pack(len(b)) + b


def dump(ks: Keyspace) -> bytes:
    now = ks.now_ms()
    out = bytearray(MAGIC)
    for key, value in ks.data.items():
        exp = ks.expires.get(key, -1)
        if exp != -1 and exp <= now:
            continue  # don't persist already-expired keys
        if isinstance(value, bytes):
            t, payload = b"S", _blob(value)
        elif isinstance(value, deque):
            t, payload = b"L", _U32.pack(len(value)) + b"".join(_blob(v) for v in value)
        elif isinstance(value, set):
            t, payload = b"T", _U32.pack(len(value)) + b"".join(_blob(v) for v in value)
        elif isinstance(value, dict):
            t, payload = b"H", _U32.pack(len(value)) + b"".join(_blob(f) + _blob(v) for f, v in value.items())
        else:  # pragma: no cover
            raise TypeError(type(value))
        out += t + _I64.pack(exp) + _blob(key) + payload
    out.append(END)
    out += _U32.pack(zlib.crc32(out))
    return bytes(out)


def load(data: bytes, ks: Keyspace) -> int:
    """Replace ks contents with the snapshot. Returns number of keys loaded (expired ones skipped)."""
    if len(data) < len(MAGIC) + 5 or not data.startswith(MAGIC):
        raise CorruptSnapshot("bad magic / too short")
    body, crc = data[:-4], _U32.unpack(data[-4:])[0]
    if zlib.crc32(body) != crc:
        raise CorruptSnapshot("checksum mismatch (truncated or corrupted file)")
    pos = len(MAGIC)

    def read_blob() -> bytes:
        nonlocal pos
        (n,) = _U32.unpack_from(body, pos)
        pos += 4
        b = body[pos:pos + n]
        pos += n
        return b

    ks.flush()
    now = ks.now_ms()
    loaded = 0
    while body[pos] != END:
        t = body[pos:pos + 1]
        pos += 1
        (exp,) = _I64.unpack_from(body, pos)
        pos += 8
        key = read_blob()
        if t == b"S":
            value = read_blob()
        elif t in (b"L", b"T"):
            (n,) = _U32.unpack_from(body, pos)
            pos += 4
            items = [read_blob() for _ in range(n)]
            value = deque(items) if t == b"L" else set(items)
        elif t == b"H":
            (n,) = _U32.unpack_from(body, pos)
            pos += 4
            value = {}
            for _ in range(n):
                f = read_blob()
                value[f] = read_blob()
        else:
            raise CorruptSnapshot(f"unknown type byte {t!r}")
        if exp != -1 and exp <= now:
            continue
        ks.store(key, value)
        if exp != -1:
            ks.set_expire_at(key, exp)
        loaded += 1
    return loaded


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic on POSIX and Windows (same volume)
