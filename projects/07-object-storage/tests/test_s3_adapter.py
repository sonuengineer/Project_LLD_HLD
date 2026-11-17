"""The same API on the S3-compatible adapter, against a REAL S3 implementation (SeaweedFS).
Skipped when the endpoint isn't running:
    MSYS_NO_PATHCONV=1 docker run -d --name objstore-seaweed -p 127.0.0.1:58333:8333 chrislusf/seaweedfs:4.48 server -s3 -dir=/data
"""
import hashlib
import os
import uuid

import httpx
import pytest

from objstore.storage.s3 import S3Adapter

from .conftest import server
from .test_objects import bucket

ENDPOINT = os.getenv("OBJ_TEST_S3_ENDPOINT", "http://127.0.0.1:58333")


def s3_up() -> bool:
    try:
        httpx.get(ENDPOINT, timeout=1)
        return True
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not s3_up(), reason="S3-compatible endpoint not running")


async def test_full_flow_on_s3_backend(db, tmp_path):
    adapter = S3Adapter(ENDPOINT, f"objstore-test-{uuid.uuid4().hex[:8]}", "any", "any")
    async with server(tmp_path, storage=adapter) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        data = os.urandom(3 * 1024 * 1024 + 123)          # > boto3's 8MB? no: exercises streaming queue anyway
        r = await a.put("photos", "big.bin", data)
        assert r.headers["etag"] == f'"{hashlib.md5(data).hexdigest()}"'
        assert (await a.get("photos", "big.bin")).content == data
        part = await a.get("photos", "big.bin", headers={"range": "bytes=1000-1999"})
        assert part.status_code == 206 and part.content == data[1000:2000]
        uid = (await a.request("POST", "/buckets/photos/uploads/mp.bin")).json()["upload_id"]
        e1 = (await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/1", content=b"a" * 10)).json()["etag"]
        e2 = (await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/2", content=b"b" * 3)).json()["etag"]
        done = await a.request("POST", f"/buckets/photos/multipart/{uid}/complete",
                               json={"parts": [{"part_number": 1, "etag": e1}, {"part_number": 2, "etag": e2}]})
        assert done.status_code == 200
        assert (await a.get("photos", "mp.bin")).content == b"a" * 10 + b"b" * 3
        await a.delete("photos", "big.bin")
        from objstore.services.maintenance import run_gc
        r = await run_gc(app.state.sm, adapter, orphan_grace_seconds=3600, deletion_grace_seconds=0)
        assert r["deleted_queued_blobs"] >= 3          # big.bin + both parts


async def test_large_streaming_upload_over_8mb_uses_s3_multipart(db, tmp_path):
    """boto3 switches to multipart above 8MB; our bounded queue feeds it without buffering the object."""
    adapter = S3Adapter(ENDPOINT, f"objstore-test-{uuid.uuid4().hex[:8]}", "any", "any")
    async with server(tmp_path, storage=adapter) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        data = os.urandom(20 * 1024 * 1024)
        assert (await a.put("photos", "20mb.bin", data, md5=False)).status_code == 200
        got = await a.get("photos", "20mb.bin")
        assert hashlib.sha256(got.content).hexdigest() == hashlib.sha256(data).hexdigest()
