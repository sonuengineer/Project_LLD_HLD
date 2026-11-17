"""On-disk record format (one frame per record):

    size    u32   length of everything after this field
    crc     u32   CRC32 of the payload below (detects torn writes and bit rot)
    offset  u64   absolute offset in the partition
    ts      i64   timestamp ms
    klen    i32   key length, -1 = null key
    key     bytes
    vlen    i32
    value   bytes

Kafka really writes record BATCHES with one CRC per batch (and compression per batch); one CRC
per record keeps this readable. Offsets are stored explicitly so a reader can verify it is where
the index said it would be.
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

_PREFIX = struct.Struct(">II")      # size, crc
_HEAD = struct.Struct(">Qqi")       # offset, ts, klen
_I32 = struct.Struct(">i")
PREFIX_SIZE = _PREFIX.size


class CorruptRecord(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Record:
    offset: int
    timestamp: int
    key: bytes | None
    value: bytes

    def encode(self) -> bytes:
        key = b"" if self.key is None else self.key
        payload = (_HEAD.pack(self.offset, self.timestamp, -1 if self.key is None else len(key)) + key
                   + _I32.pack(len(self.value)) + self.value)
        return _PREFIX.pack(len(payload) + 4, zlib.crc32(payload)) + payload


def decode_at(buf: bytes | memoryview, pos: int) -> tuple[Record, int] | None:
    """Decode the record starting at pos. Returns (record, next_pos), None if the buffer ends
    mid-record (torn tail), raises CorruptRecord if the CRC doesn't match."""
    if pos + PREFIX_SIZE > len(buf):
        return None
    size, crc = _PREFIX.unpack_from(buf, pos)
    end = pos + 4 + size
    if size < 4 + _HEAD.size + 4 or end > len(buf):
        return None
    payload = bytes(buf[pos + PREFIX_SIZE:end])
    if zlib.crc32(payload) != crc:
        raise CorruptRecord(f"crc mismatch at position {pos}")
    offset, ts, klen = _HEAD.unpack_from(payload, 0)
    p = _HEAD.size
    key = None
    if klen >= 0:
        key = payload[p:p + klen]
        p += klen
    (vlen,) = _I32.unpack_from(payload, p)
    p += 4
    return Record(offset, ts, key, payload[p:p + vlen]), end
