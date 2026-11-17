"""Local filesystem adapter.

- Blob keys are random hex; files live under root/ab/cd/<key> (sharded so no directory holds millions
  of entries).
- Writes go to a temp file, are fsync'd, then os.replace()'d into place: a reader never sees a
  half-written blob, and a crash leaves at most a temp file (cleaned by GC).
- File I/O runs in threads (asyncio.to_thread) so the event loop keeps serving other requests.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from pathlib import Path
from typing import AsyncIterator

from .base import BlobInfo, HashingStream

CHUNK = 256 * 1024


class LocalAdapter:
    name = "local"

    def __init__(self, root: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, blob_key: str) -> Path:
        if not blob_key.isalnum():          # defence in depth: keys are server-generated hex
            raise ValueError("invalid blob key")
        return self.root / blob_key[:2] / blob_key[2:4] / blob_key

    async def put(self, blob_key: str, stream: HashingStream) -> BlobInfo:
        final = self._path(blob_key)
        tmp = final.with_name(f".tmp-{uuid.uuid4().hex}")

        def _open():
            final.parent.mkdir(parents=True, exist_ok=True)
            return open(tmp, "wb")

        def _finish(fh):
            fh.flush()
            os.fsync(fh.fileno())     # bytes are on disk BEFORE the rename makes them visible
            fh.close()
            os.replace(tmp, final)
            # The rename itself lives in the directory entry: fsync the directory so it survives power loss
            # (POSIX). Windows can't open directories for fsync; NTFS journals the rename.
            if hasattr(os, "O_DIRECTORY"):
                dfd = os.open(final.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dfd)
                finally:
                    os.close(dfd)

        # Each to_thread hop costs a context switch; group the file system calls into as few hops as
        # possible (open+mkdir, one write per chunk, flush+fsync+close+rename).
        f = await asyncio.to_thread(_open)
        try:
            async for chunk in stream:
                await asyncio.to_thread(f.write, chunk)
            await asyncio.to_thread(_finish, f)
        except BaseException:
            f.close()
            tmp.unlink(missing_ok=True)
            raise
        return stream.info()

    async def get(self, blob_key: str, start: int = 0, end: int | None = None) -> AsyncIterator[bytes]:
        path = self._path(blob_key)
        f = await asyncio.to_thread(open, path, "rb")
        try:
            await asyncio.to_thread(f.seek, start)
            remaining = None if end is None else end - start + 1
            while remaining is None or remaining > 0:
                n = CHUNK if remaining is None else min(CHUNK, remaining)
                chunk = await asyncio.to_thread(f.read, n)
                if not chunk:
                    break
                if remaining is not None:
                    remaining -= len(chunk)
                yield chunk
        finally:
            f.close()

    async def delete(self, blob_key: str) -> None:
        await asyncio.to_thread(self._path(blob_key).unlink, True)

    async def exists(self, blob_key: str) -> bool:
        return await asyncio.to_thread(self._path(blob_key).exists)

    async def list_older_than(self, seconds: float) -> list[str]:
        cutoff = time.time() - seconds

        def scan():
            out = []
            for p in self.root.glob("*/*/*"):
                if p.is_file() and p.stat().st_mtime < cutoff:
                    out.append(p.name)   # includes .tmp-* leftovers from crashed writes
            return out
        return await asyncio.to_thread(scan)

    async def delete_any(self, name: str) -> None:
        """GC helper: removes blobs and crashed temp files by file name."""
        for p in self.root.glob(f"*/*/{name}"):
            await asyncio.to_thread(p.unlink, True)
