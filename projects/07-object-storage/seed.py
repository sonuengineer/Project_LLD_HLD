"""Demo: create a key, bucket, objects (incl. versions, multipart), a presigned link, and stats.
    python seed.py [base_url] [admin_token]"""
import asyncio
import sys

import httpx

from objstore.client import ObjClient

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8007"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "change-me-obj-admin"


async def main():
    async with httpx.AsyncClient(base_url=BASE) as h:
        k = (await h.post("/admin/access-keys", json={"owner": "demo", "is_admin": True},
                          headers={"x-admin-token": TOKEN})).json()
    print("access key:", k["access_key_id"])
    c = ObjClient(BASE, k["access_key_id"], k["secret"])
    print("create bucket:", (await c.request("PUT", "/buckets/demo")).status_code)
    await c.request("PUT", "/buckets/demo/versioning", json={"status": "enabled"})
    await c.put("demo", "docs/readme.txt", b"version 1", content_type="text/plain")
    r = await c.put("demo", "docs/readme.txt", b"version 2", content_type="text/plain")
    print("latest version:", r.headers["x-obj-version-id"])
    up = (await c.request("POST", "/buckets/demo/uploads/videos/clip.mp4")).json()["upload_id"]
    e1 = (await c.request("PUT", f"/buckets/demo/multipart/{up}/parts/1", content=b"0" * (5 * 1024 * 1024))).json()["etag"]
    e2 = (await c.request("PUT", f"/buckets/demo/multipart/{up}/parts/2", content=b"1" * 1000)).json()["etag"]
    done = (await c.request("POST", f"/buckets/demo/multipart/{up}/complete",
                            json={"parts": [{"part_number": 1, "etag": e1}, {"part_number": 2, "etag": e2}]})).json()
    print("multipart etag:", done["etag"], "size:", done["size"])
    link = (await c.request("POST", "/presign", json={"method": "GET", "bucket": "demo", "key": "docs/readme.txt",
                                                     "expires_in": 600})).json()["url"]
    async with httpx.AsyncClient() as anon:
        print("presigned GET:", (await anon.get(link)).text)
    print("listing:", (await c.request("GET", "/buckets/demo/objects", params={"delimiter": "/"})).json()["common_prefixes"])
    st = (await c.request("GET", "/buckets/demo/stats")).json()
    print("stats:", {k: st[k] for k in ("current_objects", "all_versions", "stored_bytes")})
    await c.aclose()


asyncio.run(main())
