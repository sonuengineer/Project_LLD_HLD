"""Append-only file: every write command, in RESP format, appended in execution order.

Durability knob (appendfsync):
    always   -> flush + fsync before replying to the client (safest, slowest; we fsync once
                per client batch = "group commit")
    everysec -> flush per batch, fsync once a second in a background thread (lose <= ~1s)
    no       -> flush per batch, the OS decides when to hit disk (fastest, least safe)

Rewrite (BGREWRITEAOF): the AOF only grows (INCR x 1M = 1M lines for one key). Rewrite
produces the *minimal* command list for the current state. While the new file is written in a
thread, new commands are captured in a rewrite buffer and appended before the atomic swap,
so nothing executed during the rewrite is lost.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from pathlib import Path
from typing import Callable

from ..keyspace import Keyspace
from ..protocol import Parser, ProtocolError, encode_command

log = logging.getLogger(__name__)
REWRITE_BATCH = 64  # elements per RPUSH/SADD/HSET in a rewritten file


class AppendOnlyFile:
    def __init__(self, path: Path, fsync_policy: str = "everysec"):
        self.path = Path(path)
        self.fsync_policy = fsync_policy
        self._file = open(self.path, "ab")
        self.rewrite_buffer: list[bytes] | None = None
        self.rewrite_in_progress = False
        self.last_rewrite_ok: bool | None = None
        self.size = self.path.stat().st_size

    def append(self, data: bytes) -> None:
        self._file.write(data)
        self.size += len(data)
        if self.rewrite_buffer is not None:
            self.rewrite_buffer.append(data)

    def flush(self) -> None:
        self._file.flush()

    def fsync(self) -> None:
        self._file.flush()
        os.fsync(self._file.fileno())

    async def fsync_in_thread(self) -> None:
        self._file.flush()
        fd = self._file.fileno()
        await asyncio.to_thread(os.fsync, fd)

    def close(self) -> None:
        try:
            self.fsync()
        finally:
            self._file.close()

    # ---- loading ------------------------------------------------------------------------
    @staticmethod
    def replay(path: Path, apply: Callable[[list[bytes]], None]) -> tuple[int, int]:
        """Re-execute every command. Returns (commands_applied, truncated_bytes).

        A crash can leave a half-written last command. Like Redis' aof-load-truncated=yes, we
        apply everything before it, log a warning and cut the file back to the last good byte.
        """
        data = Path(path).read_bytes()
        parser = Parser()
        parser.feed(data)
        applied = 0
        good_offset = 0
        try:
            while (args := parser.get_command()) is not None:
                apply(args)
                applied += 1
                good_offset = len(data) - parser.pending
        except ProtocolError as exc:
            log.error("aof_corrupted", extra={"offset": good_offset, "error": str(exc)})
            raise
        truncated = len(data) - good_offset
        if truncated:
            log.warning("aof_truncated_tail", extra={"dropped_bytes": truncated, "good_offset": good_offset})
            with open(path, "r+b") as f:
                f.truncate(good_offset)
        return applied, truncated

    # ---- rewrite ------------------------------------------------------------------------
    @staticmethod
    def minimal_commands(ks: Keyspace) -> bytes:
        now = ks.now_ms()
        out = []
        for key, value in ks.data.items():
            exp = ks.expires.get(key)
            if exp is not None and exp <= now:
                continue
            if isinstance(value, bytes):
                out.append(encode_command([b"SET", key, value]))
            else:
                if isinstance(value, deque):
                    cmd, items = b"RPUSH", list(value)
                elif isinstance(value, set):
                    cmd, items = b"SADD", list(value)
                else:
                    cmd, items = b"HSET", [x for kv in value.items() for x in kv]
                step = REWRITE_BATCH * (2 if cmd == b"HSET" else 1)
                for i in range(0, len(items), step):
                    out.append(encode_command([cmd, key, *items[i:i + step]]))
            if exp is not None:
                out.append(encode_command([b"PEXPIREAT", key, str(exp).encode()]))
        return b"".join(out)

    async def rewrite(self, ks: Keyspace) -> None:
        self.rewrite_in_progress = True
        self.rewrite_buffer = []
        tmp = self.path.with_suffix(self.path.suffix + ".rewrite")
        try:
            # 1) Build content synchronously = consistent point-in-time view (no await inside).
            content = self.minimal_commands(ks)

            # 2) Write + fsync it off the event loop. New commands keep landing in rewrite_buffer.
            def _write() -> None:
                with open(tmp, "wb") as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())

            await asyncio.to_thread(_write)
            # 3) Back on the loop (no other command can run now): append the buffered tail and swap.
            with open(tmp, "ab") as f:
                f.write(b"".join(self.rewrite_buffer))
                f.flush()
                os.fsync(f.fileno())
            self._file.close()
            os.replace(tmp, self.path)
            self._file = open(self.path, "ab")
            self.size = self.path.stat().st_size
            self.last_rewrite_ok = True
        except Exception:
            self.last_rewrite_ok = False
            log.exception("aof_rewrite_failed")
            if self._file.closed:
                self._file = open(self.path, "ab")
        finally:
            self.rewrite_buffer = None
            self.rewrite_in_progress = False
