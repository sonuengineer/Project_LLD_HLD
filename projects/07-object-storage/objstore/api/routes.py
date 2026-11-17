from __future__ import annotations

import hmac
import secrets
import time
from email.utils import formatdate

from fastapi import APIRouter, Header, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from bpcommon.errors import Conflict, Forbidden, NotFound, Unprocessable

from ..services import objects as obj
from ..services import signing
from ..services.auth import Action, Caller, authenticate, authorize
from ..services.maintenance import bucket_stats, run_gc, run_lifecycle

router = APIRouter()


async def caller(request: Request) -> Caller:
    return await authenticate(request, request.app.state.sm, request.app.state.settings.clock_skew_seconds)


def _meta_headers(request: Request) -> dict:
    return {k[len("x-obj-meta-"):]: v for k, v in request.headers.items() if k.startswith("x-obj-meta-")}


def _require_key(c: Caller) -> str:
    if c.access_key is None:
        from bpcommon.errors import Unauthorized
        raise Unauthorized("authentication required")
    return c.access_key


# ---- admin bootstrap ------------------------------------------------------------------------------
class KeyIn(BaseModel):
    owner: str = Field(min_length=1, max_length=100)
    is_admin: bool = False


@router.post("/admin/access-keys", status_code=201, tags=["admin"])
async def create_access_key(body: KeyIn, request: Request, x_admin_token: str | None = Header(default=None)):
    if not x_admin_token or not hmac.compare_digest(x_admin_token, request.app.state.settings.admin_token):
        raise Forbidden("admin token required")
    akid, secret = "OBJ" + secrets.token_hex(8).upper(), secrets.token_urlsafe(30)
    async with request.app.state.sm() as s, s.begin():
        await s.execute(text("INSERT INTO access_keys (access_key_id, secret, owner, is_admin) VALUES (:a, :s, :o, :ad)"),
                        {"a": akid, "s": secret, "o": body.owner, "ad": body.is_admin})
    return {"access_key_id": akid, "secret": secret}


@router.delete("/admin/access-keys/{access_key_id}", status_code=204, tags=["admin"])
async def revoke_access_key(access_key_id: str, request: Request, x_admin_token: str | None = Header(default=None)):
    """Revoke a key (presigned URLs it signed stop working too). Other instances' 60s secret caches
    still accept it until they expire -- the documented revocation delay."""
    if not x_admin_token or not hmac.compare_digest(x_admin_token, request.app.state.settings.admin_token):
        raise Forbidden("admin token required")
    async with request.app.state.sm() as s, s.begin():
        res = await s.execute(text("UPDATE access_keys SET revoked_at = now() WHERE access_key_id = :a AND revoked_at IS NULL"),
                              {"a": access_key_id})
    if res.rowcount == 0:
        raise NotFound("access key not found or already revoked")
    request.app.state.secret_cache.forget(access_key_id)


@router.post("/admin/lifecycle/run", tags=["admin"])
async def lifecycle_run(request: Request):
    c = await caller(request)
    if not c.is_admin:
        raise Forbidden("admin access key required")
    return await run_lifecycle(request.app.state.sm, request.app.state.storage)


@router.post("/admin/gc/run", tags=["admin"])
async def gc_run(request: Request):
    c = await caller(request)
    if not c.is_admin:
        raise Forbidden("admin access key required")
    cfg = request.app.state.settings
    return await run_gc(request.app.state.sm, request.app.state.storage, cfg.orphan_grace_seconds,
                        cfg.deletion_grace_seconds)


@router.get("/admin/stats", tags=["admin"])
async def admin_stats(request: Request):
    c = await caller(request)
    if not c.is_admin:
        raise Forbidden("admin access key required")
    async with request.app.state.sm() as s:
        names = (await s.execute(text("SELECT name FROM buckets ORDER BY name"))).scalars().all()
        stats = [await bucket_stats(s, n) for n in names]
    return {"buckets": stats, "total_stored_bytes": sum(b["stored_bytes"] for b in stats),
            "storage_backend": request.app.state.storage.name}


# ---- buckets ---------------------------------------------------------------------------------------
@router.get("/buckets", tags=["buckets"])
async def list_buckets(request: Request):
    c = await caller(request)
    akid = _require_key(c)
    async with request.app.state.sm() as s:
        rows = (await s.execute(text("SELECT name, versioning, public_read, quota_bytes, created_at FROM buckets "
                                     "WHERE owner_key = :a OR :admin ORDER BY name"), {"a": akid, "admin": c.is_admin})).mappings().all()
    return {"buckets": [dict(r) for r in rows]}


@router.put("/buckets/{bucket}", status_code=201, tags=["buckets"])
async def create_bucket(bucket: str, request: Request):
    akid = _require_key(await caller(request))
    try:
        async with request.app.state.sm() as s, s.begin():
            await s.execute(text("INSERT INTO buckets (name, owner_key) VALUES (:b, :o)"), {"b": bucket, "o": akid})
    except IntegrityError as exc:
        if "check" in str(exc.orig).lower():
            raise Unprocessable("invalid bucket name (3-63 chars: a-z 0-9 . -)") from None
        raise Conflict("bucket already exists", details={"code": "BucketAlreadyExists"}) from None
    return {"bucket": bucket}


@router.delete("/buckets/{bucket}", status_code=204, tags=["buckets"])
async def delete_bucket(bucket: str, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s, s.begin():
        await authorize(s, c, bucket, Action.ADMIN)
        if await s.scalar(text("SELECT 1 FROM objects WHERE bucket = :b LIMIT 1"), {"b": bucket}):
            raise Conflict("bucket is not empty (including old versions)", details={"code": "BucketNotEmpty"})
        if await s.scalar(text("SELECT 1 FROM multipart_uploads WHERE bucket = :b LIMIT 1"), {"b": bucket}):
            raise Conflict("bucket has in-progress multipart uploads", details={"code": "BucketNotEmpty"})
        await s.execute(text("DELETE FROM buckets WHERE name = :b"), {"b": bucket})


class VersioningIn(BaseModel):
    status: str = Field(pattern=r"^(enabled|suspended)$")   # like S3: once enabled, never back to disabled


@router.put("/buckets/{bucket}/versioning", tags=["buckets"])
async def set_versioning(bucket: str, body: VersioningIn, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s, s.begin():
        await authorize(s, c, bucket, Action.ADMIN)
        await s.execute(text("UPDATE buckets SET versioning = :v WHERE name = :b"), {"v": body.status, "b": bucket})
    return {"bucket": bucket, "versioning": body.status}


class Grant(BaseModel):
    access_key_id: str
    permission: str = Field(pattern=r"^(read|write)$")


class AclIn(BaseModel):
    public_read: bool = False
    grants: list[Grant] = []


@router.put("/buckets/{bucket}/acl", tags=["buckets"])
async def set_acl(bucket: str, body: AclIn, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s, s.begin():
        await authorize(s, c, bucket, Action.ADMIN)
        await s.execute(text("UPDATE buckets SET public_read = :p WHERE name = :b"), {"p": body.public_read, "b": bucket})
        await s.execute(text("DELETE FROM bucket_grants WHERE bucket = :b"), {"b": bucket})
        for g in body.grants:
            await s.execute(text("INSERT INTO bucket_grants (bucket, access_key_id, permission) VALUES (:b, :a, :p)"),
                            {"b": bucket, "a": g.access_key_id, "p": g.permission})
    return {"bucket": bucket, **body.model_dump()}


class QuotaIn(BaseModel):
    quota_bytes: int | None = Field(default=None, ge=0)


@router.put("/buckets/{bucket}/quota", tags=["buckets"])
async def set_quota(bucket: str, body: QuotaIn, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s, s.begin():
        await authorize(s, c, bucket, Action.ADMIN)
        await s.execute(text("UPDATE buckets SET quota_bytes = :q WHERE name = :b"), {"q": body.quota_bytes, "b": bucket})
    return {"bucket": bucket, "quota_bytes": body.quota_bytes}


class Rule(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    prefix: str = ""
    expiration_days: int | None = Field(default=None, ge=1)
    noncurrent_expiration_days: int | None = Field(default=None, ge=1)
    abort_multipart_days: int | None = Field(default=None, ge=1)


class LifecycleIn(BaseModel):
    rules: list[Rule] = Field(max_length=100)


@router.put("/buckets/{bucket}/lifecycle", tags=["buckets"])
async def set_lifecycle(bucket: str, body: LifecycleIn, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s, s.begin():
        await authorize(s, c, bucket, Action.ADMIN)
        await s.execute(text("DELETE FROM lifecycle_rules WHERE bucket = :b"), {"b": bucket})
        for r in body.rules:
            await s.execute(text("INSERT INTO lifecycle_rules (bucket, rule_id, prefix, expiration_days, "
                                 "noncurrent_expiration_days, abort_multipart_days) VALUES (:b, :i, :p, :e, :n, :a)"),
                            {"b": bucket, "i": r.id, "p": r.prefix, "e": r.expiration_days,
                             "n": r.noncurrent_expiration_days, "a": r.abort_multipart_days})
    return {"bucket": bucket, "rules": [r.model_dump() for r in body.rules]}


@router.get("/buckets/{bucket}/stats", tags=["analytics"])
async def stats(bucket: str, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s:
        await authorize(s, c, bucket, Action.READ)
        return await bucket_stats(s, bucket)


# ---- objects ---------------------------------------------------------------------------------------
@router.get("/buckets/{bucket}/objects", tags=["objects"])
async def list_objects(bucket: str, request: Request, prefix: str = "", delimiter: str | None = None,
                       start_after: str = "", max_keys: int = Query(1000, ge=1, le=1000), versions: bool = False):
    c = await caller(request)
    async with request.app.state.sm() as s:
        await authorize(s, c, bucket, Action.READ)
        if versions:
            return {"versions": await obj.list_versions(s, bucket, prefix, max_keys)}
        return await obj.list_objects(s, bucket, prefix, delimiter, start_after, max_keys)


@router.put("/buckets/{bucket}/objects/{key:path}", tags=["objects"])
async def put_object(bucket: str, key: str, request: Request, content_type: str | None = Header(default=None),
                     content_length: int | None = Header(default=None), content_md5: str | None = Header(default=None),
                     x_obj_checksum_sha256: str | None = Header(default=None)):
    c = await caller(request)
    _check_key(key)
    async with request.app.state.sm() as s:
        b = await authorize(s, c, bucket, Action.WRITE)
    cfg = request.app.state.settings
    res = await obj.put_object(request.app.state.sm, request.app.state.storage, b, key, request.stream(),
                               content_type=content_type, metadata=_meta_headers(request), max_bytes=cfg.max_object_bytes,
                               content_length=content_length, content_md5=content_md5,
                               sha256_header=x_obj_checksum_sha256, signed_sha256=c.signed_sha256)
    return Response(status_code=200, headers={"ETag": f'"{res.etag}"', "x-obj-version-id": res.version_id,
                                              "x-obj-checksum-sha256": res.sha256})


def _check_key(key: str) -> None:
    if not key or len(key.encode()) > 1024:
        raise Unprocessable("object key must be 1..1024 bytes")


def _object_headers(row: dict) -> dict:
    h = {"ETag": f'"{row["etag"]}"', "x-obj-version-id": row["version_id"], "Accept-Ranges": "bytes",
         "Last-Modified": formatdate(row["created_at"].timestamp(), usegmt=True),
         "Content-Type": row["content_type"] or "application/octet-stream"}
    if row["sha256"]:
        h["x-obj-checksum-sha256"] = row["sha256"]
    for k, v in (row["user_metadata"] or {}).items():
        h[f"x-obj-meta-{k}"] = v
    return h


@router.get("/buckets/{bucket}/objects/{key:path}", tags=["objects"])
async def get_object(bucket: str, key: str, request: Request, versionId: str | None = None,
                     range: str | None = Header(default=None), if_none_match: str | None = Header(default=None)):
    c = await caller(request)
    async with request.app.state.sm() as s:
        await authorize(s, c, bucket, Action.READ, object_read=True)
        row = await obj.head_object(s, bucket, key, versionId)
    headers = _object_headers(row)
    if if_none_match and if_none_match.strip('"') == row["etag"]:
        return Response(status_code=304, headers={"ETag": headers["ETag"]})   # client cache is still valid
    rng = obj.parse_range(range, row["size"])
    storage = request.app.state.storage
    if rng is None:
        return StreamingResponse(storage.get(row["blob_key"]), headers={**headers, "Content-Length": str(row["size"])})
    start, end = rng
    headers |= {"Content-Range": f"bytes {start}-{end}/{row['size']}", "Content-Length": str(end - start + 1)}
    return StreamingResponse(storage.get(row["blob_key"], start, end), status_code=206, headers=headers)


@router.head("/buckets/{bucket}/objects/{key:path}", tags=["objects"])
async def head(bucket: str, key: str, request: Request, versionId: str | None = None):
    c = await caller(request)
    async with request.app.state.sm() as s:
        await authorize(s, c, bucket, Action.READ, object_read=True)
        row = await obj.head_object(s, bucket, key, versionId)
    return Response(headers={**_object_headers(row), "Content-Length": str(row["size"])})


@router.delete("/buckets/{bucket}/objects/{key:path}", tags=["objects"])
async def delete_object(bucket: str, key: str, request: Request, versionId: str | None = None):
    c = await caller(request)
    async with request.app.state.sm() as s:
        b = await authorize(s, c, bucket, Action.WRITE)
    return await obj.delete_object(request.app.state.sm, request.app.state.storage, b, key, versionId)


# ---- multipart -------------------------------------------------------------------------------------
@router.post("/buckets/{bucket}/uploads/{key:path}", status_code=201, tags=["multipart"])
async def initiate(bucket: str, key: str, request: Request, content_type: str | None = Header(default=None)):
    c = await caller(request)
    _check_key(key)
    async with request.app.state.sm() as s, s.begin():
        b = await authorize(s, c, bucket, Action.WRITE)
        uid = await obj.initiate_multipart(s, b, key, content_type, _meta_headers(request), c.access_key or "anonymous")
    return {"upload_id": uid, "bucket": bucket, "key": key}


@router.put("/buckets/{bucket}/multipart/{upload_id}/parts/{part_number}", tags=["multipart"])
async def put_part(bucket: str, upload_id: str, part_number: int, request: Request,
                   content_md5: str | None = Header(default=None)):
    c = await caller(request)
    async with request.app.state.sm() as s:
        b = await authorize(s, c, bucket, Action.WRITE)
    res = await obj.upload_part(request.app.state.sm, request.app.state.storage, b, upload_id, part_number,
                                request.stream(), max_bytes=request.app.state.settings.max_object_bytes,
                                content_md5=content_md5)
    return Response(content=__import__("json").dumps(res), media_type="application/json",
                    headers={"ETag": f'"{res["etag"]}"'})


class PartRef(BaseModel):
    part_number: int
    etag: str


class CompleteIn(BaseModel):
    parts: list[PartRef]


@router.post("/buckets/{bucket}/multipart/{upload_id}/complete", tags=["multipart"])
async def complete(bucket: str, upload_id: str, body: CompleteIn, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s:
        b = await authorize(s, c, bucket, Action.WRITE)
    return await obj.complete_multipart(request.app.state.sm, request.app.state.storage, b, upload_id,
                                        [p.model_dump() for p in body.parts], request.app.state.settings.min_part_bytes)


@router.delete("/buckets/{bucket}/multipart/{upload_id}", status_code=204, tags=["multipart"])
async def abort(bucket: str, upload_id: str, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s, s.begin():
        await authorize(s, c, bucket, Action.WRITE)
        await obj.abort_multipart(s, bucket, upload_id)


@router.get("/buckets/{bucket}/multipart/{upload_id}", tags=["multipart"])
async def list_parts(bucket: str, upload_id: str, request: Request):
    c = await caller(request)
    async with request.app.state.sm() as s:
        await authorize(s, c, bucket, Action.WRITE)
        # Filter by bucket too: write access to bucket A must not reveal parts of an upload in bucket B.
        await obj._get_upload(s, bucket, upload_id)
        rows = (await s.execute(text("SELECT part_number, size, etag, uploaded_at FROM multipart_parts WHERE upload_id = :u "
                                     "ORDER BY part_number"), {"u": upload_id})).mappings().all()
    return {"upload_id": upload_id, "parts": [dict(r) for r in rows]}


# ---- presigned URLs --------------------------------------------------------------------------------
class PresignIn(BaseModel):
    method: str = Field(pattern=r"^(GET|PUT|HEAD|DELETE)$")
    bucket: str
    key: str
    expires_in: int = Field(default=3600, ge=1)
    version_id: str | None = None


@router.post("/presign", tags=["presigned urls"])
async def presign(body: PresignIn, request: Request):
    """The URL carries the SIGNER's authority: you can only presign what you can do yourself."""
    c = await caller(request)
    _require_key(c)
    cfg = request.app.state.settings
    if body.expires_in > cfg.max_presign_seconds:
        raise Unprocessable(f"expires_in must be <= {cfg.max_presign_seconds}")
    action = Action.READ if body.method in ("GET", "HEAD") else Action.WRITE
    async with request.app.state.sm() as s:
        await authorize(s, c, body.bucket, action)
        secret = await s.scalar(text("SELECT secret FROM access_keys WHERE access_key_id = :a"), {"a": c.access_key})
    path = f"/buckets/{body.bucket}/objects/{signing.quote_key(body.key)}"
    extra = f"versionId={body.version_id}" if body.version_id else ""
    expires_at = int(time.time()) + body.expires_in
    return {"url": cfg.public_base_url + signing.presign(c.access_key, secret, body.method, path, expires_at, extra),
            "method": body.method, "expires_at": expires_at}


__all__ = ["router", "NotFound"]
