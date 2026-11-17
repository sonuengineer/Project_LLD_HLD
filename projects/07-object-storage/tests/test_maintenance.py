import os
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from objstore.services.maintenance import run_gc, run_lifecycle
from objstore.storage.base import HashingStream

from .conftest import server
from .test_objects import bucket

FUTURE = lambda days: datetime.now(timezone.utc) + timedelta(days=days)  # noqa: E731


async def test_lifecycle_expiration_noncurrent_and_markers(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.request("PUT", "/buckets/photos/versioning", json={"status": "enabled"})
        await a.request("PUT", "/buckets/photos/lifecycle", json={"rules": [
            {"id": "logs", "prefix": "logs/", "expiration_days": 30, "noncurrent_expiration_days": 7}]})
        await a.put("photos", "logs/a.log", b"1")
        await a.put("photos", "logs/a.log", b"2")       # v1 becomes noncurrent now
        await a.put("photos", "keep/b.txt", b"x")       # outside the prefix
        sm, st = app.state.sm, app.state.storage
        r = await run_lifecycle(sm, st, now=FUTURE(10))  # 10 days later: noncurrent v1 (>7d) goes, current stays
        assert r["expired_noncurrent"] == 1 and r["expired_current"] == 0
        # Day 31: current v2 expires -> delete marker. The marker is stamped with REAL time (today), so in
        # simulated time v2 has already been noncurrent > 7 days -> removed in the same pass, which leaves a
        # lone delete marker -> removed too. (In real time these would happen on different days.)
        r = await run_lifecycle(sm, st, now=FUTURE(31))
        assert (r["expired_current"], r["expired_noncurrent"], r["removed_delete_markers"]) == (1, 1, 1)
        assert (await a.get("photos", "logs/a.log")).status_code == 404
        versions = (await a.request("GET", "/buckets/photos/objects", params={"versions": "true"})).json()["versions"]
        assert [v["key"] for v in versions] == ["keep/b.txt"]
        assert await run_lifecycle(sm, st, now=FUTURE(40)) == {"expired_current": 0, "expired_noncurrent": 0,
                                                               "removed_delete_markers": 0, "aborted_uploads": 0}


async def test_lifecycle_aborts_stale_multipart(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.request("PUT", "/buckets/photos/lifecycle", json={"rules": [{"id": "mp", "abort_multipart_days": 1}]})
        uid = (await a.request("POST", "/buckets/photos/uploads/forgotten.iso")).json()["upload_id"]
        await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/1", content=b"x" * 50)
        r = await run_lifecycle(app.state.sm, app.state.storage, now=FUTURE(2))
        assert r["aborted_uploads"] == 1
        stats = (await a.request("GET", "/buckets/photos/stats")).json()
        assert stats["incomplete_multipart_uploads"] == 0


async def test_gc_deletes_queued_and_orphan_blobs_but_keeps_live_ones(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.put("photos", "live", b"live data")
        await a.put("photos", "overwritten", b"old")
        await a.put("photos", "overwritten", b"new")        # old blob queued
        st = app.state.storage

        async def one():
            yield b"orphan bytes"
        # Simulate a crash after the blob write but before the metadata commit:
        await st.put("deadbeef" * 5, HashingStream(one(), 100))
        old = time.time() - 7200
        for p in (tmp_path / "blobs").glob("*/*/*"):
            os.utime(p, (old, old))                          # everything is "old enough" for GC
        r = await run_gc(app.state.sm, st, orphan_grace_seconds=3600, deletion_grace_seconds=0)
        assert r == {"deleted_queued_blobs": 1, "deleted_orphans": 1}
        assert (await a.get("photos", "live")).content == b"live data"
        assert (await a.get("photos", "overwritten")).content == b"new"
        async with db() as s:
            assert await s.scalar(text("SELECT count(*) FROM blob_deletions")) == 0


async def test_gc_respects_grace_period_for_in_flight_uploads(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        st = app.state.storage

        async def one():
            yield b"being uploaded right now"
        await st.put("cafebabe" * 5, HashingStream(one(), 100))   # brand new, not yet committed
        r = await run_gc(app.state.sm, st, orphan_grace_seconds=3600)
        assert r["deleted_orphans"] == 0 and await st.exists("cafebabe" * 5)


async def test_admin_stats(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.put("photos", "a.jpg", b"x" * 100, content_type="image/jpeg")
        await a.put("photos", "b.txt", b"x" * 10, content_type="text/plain")
        assert (await a.request("GET", "/admin/stats")).status_code == 403
        s = (await cl["admin"].request("GET", "/admin/stats")).json()
        b = s["buckets"][0]
        assert b["current_objects"] == 2 and b["current_bytes"] == 110
        assert b["by_content_type"][0]["content_type"] == "image/jpeg" and s["storage_backend"] == "local"
