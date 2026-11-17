"""Regression tests for findings from the interview-bank code review."""
import asyncio
import time

from objstore.services import signing
from objstore.services.maintenance import run_gc

from .conftest import server
from .test_objects import bucket


async def test_presigned_url_with_excessive_expiry_is_rejected_at_use(db, tmp_path):
    async with server(tmp_path, max_presign_seconds=3600) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.put("photos", "k", b"x")
        forever = signing.presign("OBJALICE", "alice-secret", "GET", "/buckets/photos/objects/k", int(time.time()) + 10 * 365 * 86400)
        r = await anon.get(forever)                      # validly signed, minted offline with a 10-year expiry
        assert r.status_code == 401 and "maximum" in r.json()["error"]["message"]


async def test_multipart_parts_respect_quota_and_completion_check_is_real(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.request("PUT", "/buckets/photos/quota", json={"quota_bytes": 100})
        uid = (await a.request("POST", "/buckets/photos/uploads/k")).json()["upload_id"]
        rs = await asyncio.gather(*[a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/{i}", content=b"x" * 30)
                                    for i in range(1, 6)])
        ok = [r for r in rs if r.status_code == 200]
        assert len(ok) == 3 and all(r.status_code in (200, 403) for r in rs)    # 3 x 30 = 90 <= 100
        stats = (await a.request("GET", "/buckets/photos/stats")).json()
        assert stats["incomplete_multipart_bytes"] == 90


async def test_gc_keeps_recently_queued_blobs_for_in_flight_downloads(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.put("photos", "k", b"old")
        await a.put("photos", "k", b"new")              # old blob queued just now
        r = await run_gc(app.state.sm, app.state.storage, orphan_grace_seconds=3600, deletion_grace_seconds=300)
        assert r["deleted_queued_blobs"] == 0            # a GET that started before the overwrite can still finish


async def test_list_parts_is_scoped_to_the_bucket(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a, b = cl["alice"], cl["bob"]
        await bucket(a, "alice-bkt")
        await bucket(b, "bob-bkt")
        uid = (await a.request("POST", "/buckets/alice-bkt/uploads/secret.iso")).json()["upload_id"]
        await a.request("PUT", f"/buckets/alice-bkt/multipart/{uid}/parts/1", content=b"x")
        r = await b.request("GET", f"/buckets/bob-bkt/multipart/{uid}")   # bob owns bob-bkt, guesses alice's id
        assert r.status_code == 404


async def test_revoked_access_key_stops_working(db, tmp_path):
    async with server(tmp_path, admin_token="adm") as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        assert (await a.request("GET", "/buckets")).status_code == 200
        r = await anon.delete("/admin/access-keys/OBJALICE", headers={"x-admin-token": "adm"})
        assert r.status_code == 204
        assert (await a.request("GET", "/buckets")).status_code == 401
