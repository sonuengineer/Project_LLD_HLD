"""A log segment = one .log file of records + one sparse .index file.

Sparse index: every `index_interval_bytes` we write (relative_offset u32, position u32). To find
offset X: binary-search the index for the greatest entry <= X, seek there, scan forward. The index
stays tiny (one entry per 4KB) yet bounds the scan to ~4KB. Kafka does exactly this (and memory-maps
the index).
"""
from __future__ import annotations

import bisect
import os
import struct
from pathlib import Path

from .record import CorruptRecord, Record, decode_at

_IDX = struct.Struct(">II")


def seg_name(base_offset: int) -> str:
    return f"{base_offset:020d}"


class Segment:
    def __init__(self, directory: Path, base_offset: int, index_interval_bytes: int = 4096):
        self.dir = directory
        self.base_offset = base_offset
        self.log_path = directory / f"{seg_name(base_offset)}.log"
        self.index_path = directory / f"{seg_name(base_offset)}.index"
        self.index_interval = index_interval_bytes
        self.index: list[tuple[int, int]] = []   # (relative offset, file position)
        self.size = 0
        self.next_offset = base_offset
        self.max_timestamp = -1
        self._bytes_since_index = 0
        self.log_path.touch(exist_ok=True)
        self.index_path.touch(exist_ok=True)
        self._recover()
        self._log = open(self.log_path, "ab")
        self._idx = open(self.index_path, "ab")
        self._reader = None   # opened lazily, then REUSED (see read())

    # ---- recovery -------------------------------------------------------------------------
    def _recover(self) -> int:
        """Rebuild the in-memory state from the files and cut off a torn/corrupt tail.
        Returns bytes truncated. (Kafka recovers only segments after the last clean flush.)"""
        data = self.log_path.read_bytes()
        pos, last_good = 0, 0
        self.index = []
        since = self.index_interval  # force an index entry for the first record
        while True:
            try:
                res = decode_at(data, pos)
            except CorruptRecord:
                res = None
            if res is None:
                break
            rec, nxt = res
            if since >= self.index_interval:
                self.index.append((rec.offset - self.base_offset, pos))
                since = 0
            since += nxt - pos
            self.next_offset = rec.offset + 1
            self.max_timestamp = max(self.max_timestamp, rec.timestamp)
            pos = last_good = nxt
        self._bytes_since_index = since
        truncated = len(data) - last_good
        if truncated:
            with open(self.log_path, "r+b") as f:
                f.truncate(last_good)
        self.size = last_good
        # Index is derived data: rewrite it from what we just scanned (it may be stale after a crash).
        with open(self.index_path, "wb") as f:
            f.write(b"".join(_IDX.pack(r, p) for r, p in self.index))
        self.recovered_truncated_bytes = truncated
        return truncated

    # ---- write ----------------------------------------------------------------------------
    def append(self, records: list[Record]) -> None:
        buf = bytearray()
        new_index = []
        pos = self.size
        for r in records:
            enc = r.encode()
            if self._bytes_since_index >= self.index_interval or not self.index and not new_index:
                new_index.append((r.offset - self.base_offset, pos + len(buf)))
                self._bytes_since_index = 0
            buf += enc
            self._bytes_since_index += len(enc)
            self.max_timestamp = max(self.max_timestamp, r.timestamp)
        self._log.write(buf)
        if new_index:
            self._idx.write(b"".join(_IDX.pack(r, p) for r, p in new_index))
            self.index.extend(new_index)
        self.size += len(buf)
        self.next_offset = records[-1].offset + 1

    def flush(self, fsync: bool = False) -> None:
        self._log.flush()
        self._idx.flush()
        if fsync:
            os.fsync(self._log.fileno())

    # ---- read -----------------------------------------------------------------------------
    def position_for(self, offset: int) -> int:
        i = bisect.bisect_right(self.index, (offset - self.base_offset, 2**32)) - 1
        return self.index[i][1] if i >= 0 else 0

    def read(self, offset: int, max_bytes: int, max_offset: int | None = None) -> list[Record]:
        """Records with offset >= `offset` (and < max_offset if given), up to ~max_bytes."""
        self._log.flush()
        start = self.position_for(offset)
        # One long-lived read handle per segment. Opening the file per fetch cost ~3ms on Windows
        # for a file that was just written (profiled: 65% of acks=all latency), vs ~0.01ms to seek+read.
        if self._reader is None or self._reader.closed:
            self._reader = open(self.log_path, "rb")
        self._reader.seek(start)
        # Read only what can exist: up to max_bytes past the index position plus one index interval
        # (the target offset can be up to index_interval bytes after the indexed position).
        want = min(max(max_bytes, 1) + self.index_interval + 4096, self.size - start)
        data = self._reader.read(max(want, 0))
        out = self._scan(data, offset, max_bytes, max_offset)
        if not out and want < self.size - start:
            # A record bigger than the read window would otherwise be returned as "nothing" forever and the
            # reader would be stuck (found in review). Like Kafka (KIP-74): always return at least one record.
            self._reader.seek(start)
            out = self._scan(self._reader.read(self.size - start), offset, 0, max_offset, first_only=True)
        return out

    def _scan(self, data: bytes, offset: int, max_bytes: int, max_offset: int | None,
              first_only: bool = False) -> list[Record]:
        out: list[Record] = []
        pos, used = 0, 0
        while True:
            res = decode_at(data, pos)
            if res is None:
                break
            rec, nxt = res
            if max_offset is not None and rec.offset >= max_offset:
                break
            if rec.offset >= offset:
                if out and used + (nxt - pos) > max_bytes:
                    break
                out.append(rec)
                used += nxt - pos
                if first_only:
                    break
            pos = nxt
        return out

    def truncate_to(self, offset: int) -> None:
        """Drop records with offset >= `offset` (follower truncation after leader change)."""
        self.flush()
        recs = self.read(self.base_offset, self.size + 1)
        keep_end = 0
        for r in recs:
            if r.offset >= offset:
                break
            keep_end += len(r.encode())
        self._log.close()
        self._idx.close()
        self._close_reader()
        with open(self.log_path, "r+b") as f:
            f.truncate(keep_end)
        self.next_offset = self.base_offset
        self._recover()
        self._log = open(self.log_path, "ab")
        self._idx = open(self.index_path, "ab")

    def close(self) -> None:
        if self._log.closed:
            return  # idempotent: a killed broker's logs are closed again on cluster shutdown
        self.flush()
        self._log.close()
        self._idx.close()
        self._close_reader()

    def _close_reader(self) -> None:
        if self._reader is not None and not self._reader.closed:
            self._reader.close()

    def delete(self) -> None:
        self.close()
        self.log_path.unlink(missing_ok=True)
        self.index_path.unlink(missing_ok=True)
