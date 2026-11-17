"""A partition's log: an ordered list of segments. Only the last (active) segment is written.

Offsets are dense and assigned here (leader) or copied from the leader (follower).
log_start_offset = first offset still on disk (advances when retention deletes segments).
log_end_offset (LEO) = next offset to be written.
"""
from __future__ import annotations

import bisect
import time
from pathlib import Path

from .record import Record
from .segment import Segment


class OffsetOutOfRange(Exception):
    pass


class Log:
    def __init__(self, directory: Path, *, segment_bytes: int = 1024 * 1024, index_interval_bytes: int = 4096,
                 retention_ms: int | None = None, retention_bytes: int | None = None,
                 fsync_every_append: bool = False):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.segment_bytes = segment_bytes
        self.index_interval = index_interval_bytes
        self.retention_ms = retention_ms
        self.retention_bytes = retention_bytes
        self.fsync_every_append = fsync_every_append
        bases = sorted(int(p.stem) for p in self.dir.glob("*.log"))
        self.segments = [Segment(self.dir, b, index_interval_bytes) for b in bases] or [Segment(self.dir, 0, index_interval_bytes)]
        self.recovered_truncated_bytes = sum(s.recovered_truncated_bytes for s in self.segments)

    # ---- offsets ------------------------------------------------------------------------------
    @property
    def log_start_offset(self) -> int:
        return self.segments[0].base_offset

    @property
    def log_end_offset(self) -> int:
        return self.segments[-1].next_offset

    @property
    def size_bytes(self) -> int:
        return sum(s.size for s in self.segments)

    # ---- write --------------------------------------------------------------------------------
    def append(self, items: list[tuple[bytes | None, bytes]], timestamp_ms: int | None = None) -> int:
        """Leader path: assign offsets. Returns the base offset of the batch."""
        ts = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
        base = self.log_end_offset
        self.append_records([Record(base + i, ts, k, v) for i, (k, v) in enumerate(items)])
        return base

    def append_records(self, records: list[Record]) -> None:
        """Follower path: offsets come from the leader and must continue our log exactly."""
        if not records:
            return
        if records[0].offset != self.log_end_offset:
            raise ValueError(f"non-contiguous append: expected {self.log_end_offset}, got {records[0].offset}")
        if self.segments[-1].size >= self.segment_bytes:
            self._roll()
        self.segments[-1].append(records)
        self.segments[-1].flush(fsync=self.fsync_every_append)

    def _roll(self) -> None:
        self.segments[-1].flush()
        self.segments.append(Segment(self.dir, self.log_end_offset, self.index_interval))

    # ---- read ---------------------------------------------------------------------------------
    def read(self, offset: int, max_bytes: int = 1024 * 1024, max_offset: int | None = None) -> list[Record]:
        """Read from `offset`. Never returns records >= max_offset (consumers pass the high watermark)."""
        if offset < self.log_start_offset or offset > self.log_end_offset:
            raise OffsetOutOfRange(f"offset {offset} not in [{self.log_start_offset}, {self.log_end_offset}]")
        upper = self.log_end_offset if max_offset is None else min(max_offset, self.log_end_offset)
        if offset >= upper:
            return []
        i = bisect.bisect_right([s.base_offset for s in self.segments], offset) - 1
        out: list[Record] = []
        budget = max_bytes
        while i < len(self.segments) and (not out or budget > 0):
            recs = self.segments[i].read(offset, budget, upper)
            out += recs
            budget -= sum(len(r.value) + (len(r.key) if r.key else 0) + 28 for r in recs)
            if recs:
                offset = recs[-1].offset + 1
            if offset >= upper:
                break
            i += 1
        return out

    # ---- maintenance --------------------------------------------------------------------------
    def apply_retention(self, now_ms: int | None = None) -> int:
        """Delete whole old segments (never the active one). Returns segments deleted.
        Retention is per segment, so data can live up to one segment longer than configured."""
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        deleted = 0
        while len(self.segments) > 1:
            oldest = self.segments[0]
            too_old = self.retention_ms is not None and oldest.max_timestamp < now - self.retention_ms
            too_big = self.retention_bytes is not None and self.size_bytes - oldest.size >= self.retention_bytes
            if not (too_old or too_big):
                break
            oldest.delete()
            self.segments.pop(0)
            deleted += 1
        return deleted

    def truncate_to(self, offset: int) -> None:
        """Remove everything >= offset (a follower discarding records the new leader doesn't have)."""
        while len(self.segments) > 1 and self.segments[-1].base_offset >= offset:
            self.segments.pop().delete()
        if offset < self.segments[-1].next_offset:
            self.segments[-1].truncate_to(max(offset, self.segments[-1].base_offset))

    def flush(self, fsync: bool = False) -> None:
        self.segments[-1].flush(fsync)

    def close(self) -> None:
        for s in self.segments:
            s.close()
