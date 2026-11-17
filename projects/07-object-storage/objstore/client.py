"""Tiny signing client (what an SDK like boto3 does for S3): builds canonical requests and signs them."""
from __future__ import annotations

import base64
import hashlib

import httpx

from .services.signing import quote_key, sign_headers


class ObjClient:
    def __init__(self, base_url: str, access_key: str, secret: str, transport: httpx.AsyncBaseTransport | None = None):
        self.http = httpx.AsyncClient(base_url=base_url, transport=transport, timeout=120)
        self.ak, self.sk = access_key, secret

    async def request(self, method: str, path: str, *, params: dict | None = None, content=None, json=None,
                      headers: dict | None = None, sign_body: bool = True) -> httpx.Response:
        req = self.http.build_request(method, path, params=params, content=content, json=json, headers=headers)
        body = req.content if (sign_body and not hasattr(content, "__aiter__")) else None
        raw_path = req.url.raw_path.decode().split("?")[0]
        req.headers.update(sign_headers(self.ak, self.sk, method, raw_path, req.url.query.decode(), body))
        return await self.http.send(req)

    async def put(self, bucket: str, key: str, data: bytes, *, content_type: str = "application/octet-stream",
                  meta: dict | None = None, md5: bool = True) -> httpx.Response:
        h = {"content-type": content_type, **{f"x-obj-meta-{k}": v for k, v in (meta or {}).items()}}
        if md5:
            h["content-md5"] = base64.b64encode(hashlib.md5(data).digest()).decode()
        return await self.request("PUT", f"/buckets/{bucket}/objects/{quote_key(key)}", content=data, headers=h)

    async def get(self, bucket: str, key: str, **kw) -> httpx.Response:
        return await self.request("GET", f"/buckets/{bucket}/objects/{quote_key(key)}", **kw)

    async def delete(self, bucket: str, key: str, version_id: str | None = None) -> httpx.Response:
        return await self.request("DELETE", f"/buckets/{bucket}/objects/{quote_key(key)}",
                                  params={"versionId": version_id} if version_id else None)

    async def aclose(self) -> None:
        await self.http.aclose()
