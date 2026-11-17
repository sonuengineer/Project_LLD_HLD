import asyncio
import base64
import hashlib
import time

import pytest

from objstore.services import signing
from objstore.services.signing import quote_key

from .conftest import server


async def bucket(c, name="photos"):
    r = await c.request("PUT", f"/buckets/{name}")
    assert r.status_code == 201, r.text


async def test_put_get_roundtrip_metadata_and_etag(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        data = b"hello object storage" * 1000
        r = await a.put("photos", "2026/trip/beach.jpg", data, content_type="image/jpeg", meta={"camera": "x100"})
        assert r.status_code == 200 and r.headers["etag"] == f'"{hashlib.md5(data).hexdigest()}"'
        g = await a.get("photos", "2026/trip/beach.jpg")
        assert g.content == data and g.headers["content-type"] == "image/jpeg"
        assert g.headers["x-obj-meta-camera"] == "x100"
        assert g.headers["x-obj-checksum-sha256"] == hashlib.sha256(data).hexdigest()
        h = await a.request("HEAD", f"/buckets/photos/objects/{quote_key('2026/trip/beach.jpg')}")
        assert h.status_code == 200 and h.headers["content-length"] == str(len(data))


async def test_integrity_checks_reject_corrupted_uploads(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        bad_md5 = base64.b64encode(hashlib.md5(b"something else").digest()).decode()
        r = await a.request("PUT", "/buckets/photos/objects/x", content=b"actual", headers={"content-md5": bad_md5})
        assert r.status_code == 400 and r.json()["error"]["code"] == "BadDigest"
        r = await a.request("PUT", "/buckets/photos/objects/x", content=b"actual",
                            headers={"x-obj-checksum-sha256": "0" * 64})
        assert r.status_code == 400
        assert (await a.get("photos", "x")).status_code == 404
        assert list((tmp_path / "blobs").glob("*/*/*")) == []        # rejected blobs were removed


async def test_signed_body_cannot_be_swapped(db, tmp_path):
    """The signature covers the body hash: a proxy that swaps the body is detected."""
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        headers = signing.sign_headers("OBJALICE", "alice-secret", "PUT", "/buckets/photos/objects/doc", "", b"original")
        r = await anon.put("/buckets/photos/objects/doc", content=b"tampered", headers=headers)
        assert r.status_code == 400 and r.json()["error"]["code"] == "BadDigest"


async def test_auth_failures(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        # signature for one path replayed on another path
        h = signing.sign_headers("OBJALICE", "alice-secret", "GET", "/buckets/photos/objects/a", "")
        assert (await anon.get("/buckets/photos/objects/b", headers=h)).status_code == 401
        old = signing.sign_headers("OBJALICE", "alice-secret", "GET", "/buckets", "", now=int(time.time()) - 3600)
        assert (await anon.get("/buckets", headers=old)).status_code == 401      # replay outside clock skew
        wrong = signing.sign_headers("OBJALICE", "not-the-secret", "GET", "/buckets", "")
        assert (await anon.get("/buckets", headers=wrong)).status_code == 401
        assert (await anon.get("/buckets")).status_code == 401


async def test_hostile_keys_never_touch_filesystem_paths(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        for key in ["../../etc/passwd", "a/../../b", "emoji/\U0001F600.txt", "spaces and %25 and ?q=1", "\\windows\\path"]:
            assert (await a.put("photos", key, key.encode())).status_code == 200, key
            assert (await a.get("photos", key)).content == key.encode()
        files = [p for p in tmp_path.rglob("*") if p.is_file()]
        assert all(p.is_relative_to(tmp_path / "blobs") and p.name.isalnum() for p in files)


async def test_range_requests_and_conditional_get(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        data = bytes(range(256)) * 100
        etag = (await a.put("photos", "f.bin", data)).headers["etag"]
        r = await a.get("photos", "f.bin", headers={"range": "bytes=100-199"})
        assert r.status_code == 206 and r.content == data[100:200]
        assert r.headers["content-range"] == f"bytes 100-199/{len(data)}"
        assert (await a.get("photos", "f.bin", headers={"range": "bytes=-10"})).content == data[-10:]
        assert (await a.get("photos", "f.bin", headers={"range": "bytes=99999-"})).status_code == 416
        assert (await a.get("photos", "f.bin", headers={"if-none-match": etag})).status_code == 304


async def test_versioning_and_delete_markers(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.request("PUT", "/buckets/photos/versioning", json={"status": "enabled"})
        v1 = (await a.put("photos", "doc.txt", b"v1")).headers["x-obj-version-id"]
        v2 = (await a.put("photos", "doc.txt", b"v2")).headers["x-obj-version-id"]
        assert v1 != v2 and (await a.get("photos", "doc.txt")).content == b"v2"
        assert (await a.get("photos", "doc.txt", params={"versionId": v1})).content == b"v1"
        d = (await a.delete("photos", "doc.txt")).json()
        assert d["delete_marker"] is True
        gone = await a.get("photos", "doc.txt")
        assert gone.status_code == 404 and gone.headers["x-obj-delete-marker"] == "true"
        versions = (await a.request("GET", "/buckets/photos/objects", params={"versions": "true"})).json()["versions"]
        assert [(v["version_id"] == d["version_id"], v["is_delete_marker"], v["is_latest"]) for v in versions] == [
            (True, True, True), (False, False, False), (False, False, False)]
        # "undelete": remove the delete marker version -> v2 is current again
        await a.delete("photos", "doc.txt", version_id=d["version_id"])
        assert (await a.get("photos", "doc.txt")).content == b"v2"
        # permanently delete v2 -> v1 becomes latest
        await a.delete("photos", "doc.txt", version_id=v2)
        assert (await a.get("photos", "doc.txt")).content == b"v1"


async def test_unversioned_overwrite_queues_old_blob(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.put("photos", "k", b"old")
        await a.put("photos", "k", b"new")
        async with db() as s:
            from sqlalchemy import text
            assert await s.scalar(text("SELECT count(*) FROM objects")) == 1
            assert await s.scalar(text("SELECT count(*) FROM blob_deletions")) == 1


async def test_listing_prefix_delimiter_pagination(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        for k in ["a.txt", "docs/1.txt", "docs/2.txt", "docs/sub/3.txt", "img/x.png", "100%_done.txt", "100xxdone.txt"]:
            await a.put("photos", k, b"x")
        r = (await a.request("GET", "/buckets/photos/objects", params={"delimiter": "/"})).json()
        assert [c["key"] for c in r["contents"]] == ["100%_done.txt", "100xxdone.txt", "a.txt"]
        assert r["common_prefixes"] == ["docs/", "img/"]
        r = (await a.request("GET", "/buckets/photos/objects", params={"prefix": "docs/", "delimiter": "/"})).json()
        assert [c["key"] for c in r["contents"]] == ["docs/1.txt", "docs/2.txt"] and r["common_prefixes"] == ["docs/sub/"]
        r = (await a.request("GET", "/buckets/photos/objects", params={"prefix": "100%_"})).json()   # LIKE escaped
        assert [c["key"] for c in r["contents"]] == ["100%_done.txt"]
        page1 = (await a.request("GET", "/buckets/photos/objects", params={"max_keys": "3"})).json()
        page2 = (await a.request("GET", "/buckets/photos/objects",
                                 params={"max_keys": "10", "start_after": page1["next_start_after"]})).json()
        assert page1["is_truncated"] and len(page1["contents"]) + len(page2["contents"]) == 7


async def test_multipart_upload(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        up = (await a.request("POST", "/buckets/photos/uploads/big/video.mp4", headers={"content-type": "video/mp4"})).json()
        uid = up["upload_id"]
        parts = [b"A" * 10, b"B" * 10, b"C" * 3]
        etags = []
        for i, p in enumerate(parts, 1):
            r = await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/{i}", content=p)
            etags.append(r.json()["etag"])
        r2 = await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/2", content=b"b" * 10)   # retry replaces
        etags[1] = r2.json()["etag"]
        bad = await a.request("POST", f"/buckets/photos/multipart/{uid}/complete",
                              json={"parts": [{"part_number": 2, "etag": etags[1]}, {"part_number": 1, "etag": etags[0]}]})
        assert bad.status_code == 400
        done = (await a.request("POST", f"/buckets/photos/multipart/{uid}/complete",
                                json={"parts": [{"part_number": i + 1, "etag": e} for i, e in enumerate(etags)]})).json()
        expected_etag = hashlib.md5(b"".join(hashlib.md5(p).digest() for p in [parts[0], b"b" * 10, parts[2]])).hexdigest() + "-3"
        assert done["etag"] == expected_etag and done["size"] == 23
        g = await a.get("photos", "big/video.mp4")
        assert g.content == b"A" * 10 + b"b" * 10 + b"C" * 3 and g.headers["content-type"] == "video/mp4"


async def test_multipart_min_part_size_and_abort(db, tmp_path):
    async with server(tmp_path, min_part_bytes=8) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        uid = (await a.request("POST", "/buckets/photos/uploads/k")).json()["upload_id"]
        e1 = (await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/1", content=b"tiny")).json()["etag"]
        e2 = (await a.request("PUT", f"/buckets/photos/multipart/{uid}/parts/2", content=b"last")).json()["etag"]
        r = await a.request("POST", f"/buckets/photos/multipart/{uid}/complete",
                            json={"parts": [{"part_number": 1, "etag": e1}, {"part_number": 2, "etag": e2}]})
        assert r.status_code == 400 and r.json()["error"]["details"]["code"] == "EntityTooSmall"
        assert (await a.request("DELETE", f"/buckets/photos/multipart/{uid}")).status_code == 204
        assert (await a.request("GET", f"/buckets/photos/multipart/{uid}")).status_code == 404   # upload is gone


async def test_presigned_urls(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.put("photos", "share/me.txt", b"shared")
        url = (await a.request("POST", "/presign", json={"method": "GET", "bucket": "photos", "key": "share/me.txt",
                                                        "expires_in": 60})).json()["url"]
        path = url.replace("http://obj", "")
        assert (await anon.get(path)).content == b"shared"                       # no credentials needed
        assert (await anon.delete(path)).status_code == 401                      # method is signed
        assert (await anon.get(path.replace("me.txt", "other.txt"))).status_code == 401   # key is signed
        expired = signing.presign("OBJALICE", "alice-secret", "GET", "/buckets/photos/objects/share/me.txt", int(time.time()) - 1)
        assert (await anon.get(expired)).status_code == 401
        put_url = (await a.request("POST", "/presign", json={"method": "PUT", "bucket": "photos", "key": "upload.bin",
                                                            "expires_in": 60})).json()["url"]
        assert (await anon.put(put_url.replace("http://obj", ""), content=b"from browser")).status_code == 200
        assert (await a.get("photos", "upload.bin")).content == b"from browser"
        # bob can't presign alice's bucket (no permission -> can't delegate it)
        assert (await cl["bob"].request("POST", "/presign", json={"method": "GET", "bucket": "photos",
                                                                 "key": "share/me.txt"})).status_code == 403


async def test_access_control(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a, b = cl["alice"], cl["bob"]
        await bucket(a)
        await a.put("photos", "p.jpg", b"img")
        assert (await b.get("photos", "p.jpg")).status_code == 403
        assert (await anon.get("/buckets/photos/objects/p.jpg")).status_code == 401
        await a.request("PUT", "/buckets/photos/acl", json={"public_read": True, "grants": [
            {"access_key_id": "OBJBOB", "permission": "read"}]})
        assert (await anon.get("/buckets/photos/objects/p.jpg")).content == b"img"      # public object read
        assert (await anon.get("/buckets/photos/objects")).status_code == 401           # but not listing
        assert (await b.get("photos", "p.jpg")).status_code == 200
        assert (await b.put("photos", "p.jpg", b"overwrite")).status_code == 403        # read grant only
        assert (await b.request("PUT", "/buckets/photos/acl", json={"public_read": False})).status_code == 403
        assert (await cl["admin"].get("photos", "p.jpg")).status_code == 200


async def test_quota_counts_all_versions(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a)
        await a.request("PUT", "/buckets/photos/versioning", json={"status": "enabled"})
        await a.request("PUT", "/buckets/photos/quota", json={"quota_bytes": 1000})
        assert (await a.put("photos", "k", b"x" * 600)).status_code == 200
        r = await a.put("photos", "k", b"y" * 600)            # new version: 1200 > 1000 stored
        assert r.status_code == 403 and r.json()["error"]["code"] == "QuotaExceeded"
        stats = (await a.request("GET", "/buckets/photos/stats")).json()
        assert stats["stored_bytes"] == 600 and stats["quota_used_pct"] == 60.0


async def test_concurrent_writes_to_same_key(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        await bucket(a, "ver")
        await bucket(a, "plain")
        await a.request("PUT", "/buckets/ver/versioning", json={"status": "enabled"})
        await asyncio.gather(*[a.put("ver", "hot", f"v{i}".encode()) for i in range(20)])
        await asyncio.gather(*[a.put("plain", "hot", f"v{i}".encode()) for i in range(20)])
        from sqlalchemy import text
        async with db() as s:
            assert await s.scalar(text("SELECT count(*) FROM objects WHERE bucket = 'ver'")) == 20
            assert await s.scalar(text("SELECT count(*) FROM objects WHERE bucket = 'ver' AND is_latest")) == 1
            assert await s.scalar(text("SELECT count(*) FROM objects WHERE bucket = 'plain'")) == 1
            assert await s.scalar(text("SELECT count(*) FROM blob_deletions")) == 19   # 19 overwritten blobs queued
        latest = (await a.get("ver", "hot")).content
        assert latest.startswith(b"v")


async def test_bucket_rules(db, tmp_path):
    async with server(tmp_path) as (app, cl, anon):
        a = cl["alice"]
        assert (await a.request("PUT", "/buckets/Bad_Name")).status_code == 422
        await bucket(a)
        assert (await a.request("PUT", "/buckets/photos")).status_code == 409
        await a.put("photos", "k", b"x")
        assert (await a.request("DELETE", "/buckets/photos")).status_code == 409
        await a.delete("photos", "k")
        assert (await a.request("DELETE", "/buckets/photos")).status_code == 204
