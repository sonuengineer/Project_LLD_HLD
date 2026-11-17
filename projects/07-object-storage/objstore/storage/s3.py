"""S3-compatible adapter (AWS S3, MinIO, SeaweedFS, Ceph RGW ...) via boto3.

boto3 is synchronous, so calls run in threads. Uploads use boto3's managed multipart upload fed by a
bounded queue -> constant memory regardless of object size.
"""
from __future__ import annotations

import asyncio
import io
import threading
import time
from typing import AsyncIterator

import boto3
from botocore.config import Config

from .base import BlobInfo, HashingStream


class _QueueReader(io.RawIOBase):
    """File-like object that boto3 reads from; the event loop feeds it chunk by chunk."""

    def __init__(self):
        self._chunks: list[bytes] = []
        self._cv = threading.Condition()
        self._closed_for_write = False
        self._buf = b""
        self.error: BaseException | None = None

    def feed(self, chunk: bytes) -> None:
        with self._cv:
            while len(self._chunks) > 8:          # backpressure: at most ~8 chunks buffered
                self._cv.wait()
            self._chunks.append(chunk)
            self._cv.notify_all()

    def finish(self, error: BaseException | None = None) -> None:
        with self._cv:
            self._closed_for_write = True
            self.error = error
            self._cv.notify_all()

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        with self._cv:
            while not self._buf:
                if self._chunks:
                    self._buf = self._chunks.pop(0)
                    self._cv.notify_all()
                    break
                if self._closed_for_write:
                    if self.error:
                        raise IOError(str(self.error))
                    return 0
                self._cv.wait()
            n = min(len(b), len(self._buf))
            b[:n] = self._buf[:n]
            self._buf = self._buf[n:]
            return n


class S3Adapter:
    name = "s3"

    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str = "us-east-1"):
        self.bucket = bucket
        self.client = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=access_key,
                                   aws_secret_access_key=secret_key, region_name=region,
                                   config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}))

    async def ensure_bucket(self) -> None:
        def make():
            try:
                self.client.head_bucket(Bucket=self.bucket)
            except Exception:
                self.client.create_bucket(Bucket=self.bucket)
        await asyncio.to_thread(make)

    async def put(self, blob_key: str, stream: HashingStream) -> BlobInfo:
        reader = _QueueReader()
        upload = asyncio.to_thread(self.client.upload_fileobj, io.BufferedReader(reader), self.bucket, blob_key)
        task = asyncio.ensure_future(upload)
        try:
            async for chunk in stream:
                await asyncio.to_thread(reader.feed, chunk)
            reader.finish()
        except BaseException as exc:
            reader.finish(exc)
            try:
                await task
            except Exception:
                pass
            raise
        await task
        return stream.info()

    async def get(self, blob_key: str, start: int = 0, end: int | None = None) -> AsyncIterator[bytes]:
        rng = f"bytes={start}-{'' if end is None else end}"
        resp = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=blob_key, Range=rng)
        body = resp["Body"]
        try:
            while True:
                chunk = await asyncio.to_thread(body.read, 256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            body.close()

    async def delete(self, blob_key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=blob_key)

    async def exists(self, blob_key: str) -> bool:
        try:
            await asyncio.to_thread(self.client.head_object, Bucket=self.bucket, Key=blob_key)
            return True
        except Exception:
            return False

    async def list_older_than(self, seconds: float) -> list[str]:
        cutoff = time.time() - seconds

        def scan():
            out, token = [], None
            while True:
                kw = {"Bucket": self.bucket, "MaxKeys": 1000}
                if token:
                    kw["ContinuationToken"] = token
                r = self.client.list_objects_v2(**kw)
                out += [o["Key"] for o in r.get("Contents", []) if o["LastModified"].timestamp() < cutoff]
                if not r.get("IsTruncated"):
                    return out
                token = r["NextContinuationToken"]
        return await asyncio.to_thread(scan)

    async def delete_any(self, name: str) -> None:
        await self.delete(name)
