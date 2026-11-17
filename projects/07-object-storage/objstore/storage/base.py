"""Blob storage abstraction. Metadata (names, versions, ACLs) lives in Postgres; this layer only
stores opaque byte blobs under random keys."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import AsyncIterator, Protocol


@dataclass
class BlobInfo:
    size: int
    md5: str
    sha256: str


class TooLarge(Exception):
    pass


class HashingStream:
    """Wraps an async byte iterator: computes md5 + sha256 and counts bytes while streaming,
    and aborts as soon as `max_bytes` is exceeded (we never buffer a whole object in memory)."""

    def __init__(self, source: AsyncIterator[bytes], max_bytes: int):
        self.source, self.max = source, max_bytes
        self.md5, self.sha = hashlib.md5(), hashlib.sha256()
        self.size = 0

    async def __aiter__(self):
        async for chunk in self.source:
            if not chunk:
                continue
            self.size += len(chunk)
            if self.size > self.max:
                raise TooLarge(f"object exceeds {self.max} bytes")
            self.md5.update(chunk)
            self.sha.update(chunk)
            yield chunk

    def info(self) -> BlobInfo:
        return BlobInfo(self.size, self.md5.hexdigest(), self.sha.hexdigest())


class StorageAdapter(Protocol):
    name: str

    async def put(self, blob_key: str, stream: HashingStream) -> BlobInfo: ...

    async def get(self, blob_key: str, start: int = 0, end: int | None = None) -> AsyncIterator[bytes]: ...

    async def delete(self, blob_key: str) -> None: ...

    async def exists(self, blob_key: str) -> bool: ...

    async def list_older_than(self, seconds: float) -> list[str]: ...
