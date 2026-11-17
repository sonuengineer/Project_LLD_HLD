"""Authenticate a request (signed header, presigned URL, or anonymous) and authorise bucket actions."""
from __future__ import annotations

import hmac
import time
from dataclasses import dataclass
from enum import StrEnum

from fastapi import Request
from sqlalchemy import text

from bpcommon.errors import Forbidden, Unauthorized

from . import signing


class Action(StrEnum):
    READ = "read"      # GET/HEAD object, list
    WRITE = "write"    # PUT/DELETE object, multipart
    ADMIN = "admin"    # bucket config: versioning, acl, quota, lifecycle, delete bucket


@dataclass
class Caller:
    access_key: str | None          # None = anonymous
    is_admin: bool = False
    via_presign: bool = False
    signed_sha256: str | None = None  # body hash the signature covers (None/UNSIGNED = not covered)


async def authenticate(request: Request, sm, skew: int) -> Caller:
    q = request.url.query
    raw_path = request.scope.get("raw_path", request.url.path.encode()).decode()
    params = dict(request.query_params)
    if "X-Obj-Signature" in params:
        return await _presigned(request, sm, raw_path, q, params)
    header = request.headers.get("authorization")
    if not header:
        return Caller(None)
    parsed = signing.parse_auth_header(header)
    if parsed is None:
        raise Unauthorized("malformed Authorization header")
    akid, sig = parsed
    date = request.headers.get("x-obj-date", "")
    sha = request.headers.get("x-obj-content-sha256", "")
    try:
        if abs(time.time() - int(date)) > skew:
            raise Unauthorized("request date outside allowed clock skew (possible replay)")
    except ValueError:
        raise Unauthorized("missing or invalid x-obj-date") from None
    if not sha:
        raise Unauthorized("missing x-obj-content-sha256")
    secret, is_admin = await _secret(sm, akid, getattr(request.app.state, "secret_cache", None))
    expected = signing.sign(secret, signing.string_to_sign(request.method, raw_path, q, date, sha))
    if not hmac.compare_digest(expected, sig):
        raise Unauthorized("signature does not match")
    return Caller(akid, is_admin, signed_sha256=None if sha == signing.UNSIGNED else sha)


async def _presigned(request: Request, sm, raw_path: str, q: str, params: dict) -> Caller:
    akid, expires, sig = params.get("X-Obj-Credential"), params.get("X-Obj-Expires"), params["X-Obj-Signature"]
    max_age = request.app.state.settings.max_presign_seconds
    try:
        exp = int(expires)
    except (TypeError, ValueError):
        raise Unauthorized("invalid presigned URL") from None
    if exp < time.time():
        raise Unauthorized("presigned URL expired")
    if exp > time.time() + max_age + 60:
        # Enforced at USE time too: anyone holding a secret can mint URLs offline, bypassing /presign's check.
        raise Unauthorized(f"presigned URL expiry exceeds the maximum of {max_age}s")
    secret, is_admin = await _secret(sm, akid or "", getattr(request.app.state, "secret_cache", None))
    expected = signing.sign(secret, signing.presigned_string(request.method, raw_path, q, expires))
    if not hmac.compare_digest(expected, sig):
        raise Unauthorized("presigned signature does not match (wrong method, path, or tampered query)")
    return Caller(akid, is_admin, via_presign=True)


class SecretCache:
    """Per-app-instance cache of access-key secrets (60s). Saves a DB round trip per request. Cost: a revoked key
    keeps working on OTHER instances for up to the TTL; unknown keys are cached too (bogus-id floods are cheap).
    Instance-scoped (app.state), not module-global: a global cache leaked revocations between app instances in one
    process (found by the test suite)."""

    TTL = 60.0

    def __init__(self):
        self._d: dict[str, tuple[float, tuple[str, bool] | None]] = {}

    def get(self, akid):
        hit = self._d.get(akid)
        return hit[1] if hit and hit[0] > time.monotonic() else ...

    def put(self, akid, value) -> None:
        if len(self._d) > 10_000:
            self._d.clear()
        self._d[akid] = (time.monotonic() + self.TTL, value)

    def forget(self, akid) -> None:
        self._d.pop(akid, None)


async def _secret(sm, akid: str, cache: SecretCache | None = None) -> tuple[str, bool]:
    found = cache.get(akid) if cache else ...
    if found is ...:
        async with sm() as s:
            row = (await s.execute(text("SELECT secret, is_admin FROM access_keys WHERE access_key_id = :a "
                                        "AND revoked_at IS NULL"), {"a": akid})).first()
        found = (row.secret, row.is_admin) if row else None
        if cache:
            cache.put(akid, found)
    if found is None:
        raise Unauthorized("unknown or revoked access key")
    return found


async def authorize(s, caller: Caller, bucket: str, action: Action, *, object_read: bool = False) -> dict:
    """Returns the bucket row. 404 for buckets that don't exist; 403 when not allowed."""
    b = (await s.execute(text("SELECT name, owner_key, versioning, public_read, quota_bytes FROM buckets WHERE name = :b"),
                         {"b": bucket})).mappings().first()
    if b is None:
        from bpcommon.errors import NotFound
        raise NotFound(f"bucket {bucket!r} not found", details={"code": "NoSuchBucket"})
    if caller.is_admin or (caller.access_key and caller.access_key == b["owner_key"]):
        return dict(b)
    if action is Action.ADMIN:
        raise Forbidden("only the bucket owner can change bucket configuration")
    if action is Action.READ and object_read and b["public_read"]:
        return dict(b)
    if caller.access_key is None:
        raise Unauthorized("authentication required")
    grants = set((await s.execute(text("SELECT permission FROM bucket_grants WHERE bucket = :b AND access_key_id = :a"),
                                  {"b": bucket, "a": caller.access_key})).scalars().all())
    if action.value in grants or (action is Action.READ and "write" in grants):
        return dict(b)
    raise Forbidden(f"access denied: {action.value} on bucket {bucket!r}")
