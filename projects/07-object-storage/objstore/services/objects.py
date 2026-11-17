"""Object operations: put (streaming), get (ranges), delete (versioning + delete markers), list,
multipart uploads. Postgres holds metadata; the storage adapter holds bytes.

Write path ordering (crash safety):
  1. stream bytes into a NEW random blob (no lock held while the client uploads)
  2. short transaction: advisory lock on (bucket, key) -> quota check -> flip versions -> commit
  3. blobs that are no longer referenced are queued in blob_deletions (deleted asynchronously)
A crash after 1 but before 2 leaves an orphan blob that metadata never references; the GC removes
it after a grace period. The opposite order (metadata first) could expose metadata pointing at
bytes that don't exist -- much worse.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid
from dataclasses import dataclass
from typing import AsyncIterator

from sqlalchemy import text

from bpcommon.errors import AppError, Conflict, NotFound

from ..storage.base import HashingStream, TooLarge


class BadDigest(AppError):
    status_code, code = 400, "BadDigest"


class EntityTooLarge(AppError):
    status_code, code = 413, "EntityTooLarge"


class QuotaExceeded(AppError):
    status_code, code = 403, "QuotaExceeded"


class InvalidPart(AppError):
    status_code, code = 400, "InvalidPart"


class InvalidRange(AppError):
    status_code, code = 416, "InvalidRange"


def new_blob_key() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex[:8]


def new_version_id() -> str:
    return uuid.uuid4().hex


def key_lock_sql() -> str:
    # Transaction-scoped advisory lock: serialises concurrent writers of the SAME key only.
    return "SELECT pg_advisory_xact_lock(hashtextextended(:b || '/' || :k, 0))"


@dataclass
class PutResult:
    version_id: str
    etag: str
    size: int
    sha256: str


async def _queue_blob_deletion(s, blob_key: str | None) -> None:
    if blob_key:
        await s.execute(text("INSERT INTO blob_deletions (blob_key) VALUES (:b) ON CONFLICT DO NOTHING"), {"b": blob_key})


async def commit_version(s, bucket: dict, key: str, *, blob_key: str | None, size: int, etag: str | None,
                         sha256: str | None, content_type: str | None, metadata: dict,
                         delete_marker: bool = False) -> str:
    """Insert a new version (or delete marker) as the latest, honouring the bucket's versioning state.
    Caller must hold the key advisory lock in the same transaction."""
    versioning = bucket["versioning"]
    current = (await s.execute(text("SELECT id, version_id, blob_key FROM objects WHERE bucket = :b AND key = :k AND is_latest"),
                               {"b": bucket["name"], "k": key})).first()
    if versioning == "enabled":
        version_id = new_version_id()
        if current:
            await s.execute(text("UPDATE objects SET is_latest = false WHERE id = :i"), {"i": current.id})
    else:
        # disabled / suspended: the 'null' version is overwritten in place (older real versions survive
        # when suspended, as in S3).
        version_id = "null"
        null_row = (await s.execute(text("SELECT id, blob_key, is_latest FROM objects WHERE bucket = :b AND key = :k "
                                         "AND version_id = 'null'"), {"b": bucket["name"], "k": key})).first()
        if null_row:
            await s.execute(text("DELETE FROM objects WHERE id = :i"), {"i": null_row.id})
            await _queue_blob_deletion(s, null_row.blob_key)
        if current and (not null_row or current.id != null_row.id):
            await s.execute(text("UPDATE objects SET is_latest = false WHERE id = :i"), {"i": current.id})
    await s.execute(text(
        "INSERT INTO objects (bucket, key, version_id, is_latest, is_delete_marker, size, etag, sha256, content_type, "
        "user_metadata, blob_key) VALUES (:b, :k, :v, true, :dm, :sz, :e, :sha, :ct, CAST(:md AS jsonb), :bk)"),
        {"b": bucket["name"], "k": key, "v": version_id, "dm": delete_marker, "sz": size, "e": etag, "sha": sha256,
         "ct": content_type, "md": json.dumps(metadata), "bk": blob_key})
    return version_id


async def _check_quota(s, bucket: dict, adding: int) -> None:
    if bucket["quota_bytes"] is None:
        return
    # Every stored version counts (that's what you pay for in S3 too).
    # sum(bigint) is NUMERIC in Postgres -> Decimal in Python: cast for arithmetic + JSON.
    used = int(await s.scalar(text("SELECT coalesce(sum(size), 0) FROM objects WHERE bucket = :b"), {"b": bucket["name"]}))
    parts = int(await s.scalar(text("SELECT coalesce(sum(p.size), 0) FROM multipart_parts p JOIN multipart_uploads u "
                                "ON u.upload_id = p.upload_id WHERE u.bucket = :b"), {"b": bucket["name"]}))
    if used + parts + adding > bucket["quota_bytes"]:
        raise QuotaExceeded(f"bucket quota of {bucket['quota_bytes']} bytes exceeded",
                            details={"used": used + parts, "adding": adding, "quota": bucket["quota_bytes"]})


def _verify_digests(info, content_md5: str | None, sha256_header: str | None, signed_sha256: str | None) -> None:
    if content_md5:
        try:
            expected = base64.b64decode(content_md5, validate=True).hex()
        except (binascii.Error, ValueError):
            raise BadDigest("Content-MD5 is not valid base64") from None
        if expected != info.md5:
            raise BadDigest("Content-MD5 does not match the received body (corrupted in transit?)")
    for label, value in (("x-obj-checksum-sha256", sha256_header), ("signed payload", signed_sha256)):
        if value and value.lower() != info.sha256:
            raise BadDigest(f"{label} does not match the received body")


async def put_object(sm, storage, bucket: dict, key: str, body: AsyncIterator[bytes], *, content_type: str | None,
                     metadata: dict, max_bytes: int, content_length: int | None, content_md5: str | None,
                     sha256_header: str | None, signed_sha256: str | None) -> PutResult:
    if content_length is not None and content_length > max_bytes:
        raise EntityTooLarge(f"object larger than {max_bytes} bytes; use multipart upload")
    blob_key = new_blob_key()
    stream = HashingStream(body, max_bytes)
    try:
        info = await storage.put(blob_key, stream)
    except TooLarge as exc:
        raise EntityTooLarge(str(exc)) from None
    try:
        _verify_digests(info, content_md5, sha256_header, signed_sha256)
        async with sm() as s, s.begin():
            await s.execute(text(key_lock_sql()), {"b": bucket["name"], "k": key})
            if bucket["quota_bytes"] is not None:
                # Only quota'd buckets need bucket-wide serialisation (check-then-insert must not race).
                # Locking unconditionally serialised EVERY write in the bucket (measured: 53 PUT/s).
                await s.execute(text("SELECT 1 FROM buckets WHERE name = :b FOR UPDATE"), {"b": bucket["name"]})
                await _check_quota(s, bucket, info.size)
            vid = await commit_version(s, bucket, key, blob_key=blob_key, size=info.size, etag=info.md5,
                                       sha256=info.sha256, content_type=content_type, metadata=metadata)
    except BaseException:
        await storage.delete(blob_key)   # nothing references it; best effort (GC catches failures)
        raise
    return PutResult(vid, info.md5, info.size, info.sha256)


async def head_object(s, bucket: str, key: str, version_id: str | None = None) -> dict:
    if version_id:
        row = (await s.execute(text("SELECT * FROM objects WHERE bucket = :b AND key = :k AND version_id = :v"),
                               {"b": bucket, "k": key, "v": version_id})).mappings().first()
    else:
        row = (await s.execute(text("SELECT * FROM objects WHERE bucket = :b AND key = :k AND is_latest"),
                               {"b": bucket, "k": key})).mappings().first()
    if row is None:
        raise NotFound("object not found", details={"code": "NoSuchKey"})
    if row["is_delete_marker"]:
        raise NotFound("object deleted (latest version is a delete marker)",
                       details={"code": "NoSuchKey", "delete_marker": True, "version_id": row["version_id"]},
                       headers={"x-obj-delete-marker": "true", "x-obj-version-id": row["version_id"]})
    return dict(row)


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """'bytes=0-99', 'bytes=100-', 'bytes=-50' (last 50). Single range only."""
    if not header:
        return None
    if not header.startswith("bytes=") or "," in header:
        raise InvalidRange("only a single bytes range is supported")
    a, _, b = header[6:].partition("-")
    try:
        if a == "":
            n = int(b)
            start, end = max(size - n, 0), size - 1
        else:
            start = int(a)
            end = int(b) if b else size - 1
    except ValueError:
        raise InvalidRange("malformed Range") from None
    end = min(end, size - 1)
    if start > end or start >= size:
        raise InvalidRange(f"range not satisfiable for size {size}")
    return start, end


async def delete_object(sm, storage, bucket: dict, key: str, version_id: str | None) -> dict:
    async with sm() as s, s.begin():
        await s.execute(text(key_lock_sql()), {"b": bucket["name"], "k": key})
        if version_id:
            # Permanently remove one specific version; promote the next newest if it was latest.
            row = (await s.execute(text("DELETE FROM objects WHERE bucket = :b AND key = :k AND version_id = :v "
                                        "RETURNING is_latest, blob_key, is_delete_marker"),
                                   {"b": bucket["name"], "k": key, "v": version_id})).first()
            if row is None:
                raise NotFound("version not found", details={"code": "NoSuchVersion"})
            await _queue_blob_deletion(s, row.blob_key)
            if row.is_latest:
                await s.execute(text(
                    "UPDATE objects SET is_latest = true WHERE id = (SELECT id FROM objects WHERE bucket = :b AND key = :k "
                    "ORDER BY created_at DESC, id DESC LIMIT 1)"), {"b": bucket["name"], "k": key})
            return {"version_id": version_id, "delete_marker": row.is_delete_marker, "permanent": True}
        if bucket["versioning"] == "disabled":
            row = (await s.execute(text("DELETE FROM objects WHERE bucket = :b AND key = :k RETURNING blob_key"),
                                   {"b": bucket["name"], "k": key})).first()
            if row:
                await _queue_blob_deletion(s, row.blob_key)
            return {"deleted": row is not None}       # S3 returns 204 either way (idempotent delete)
        # enabled / suspended: a delete marker becomes the latest version; data stays recoverable.
        vid = await commit_version(s, bucket, key, blob_key=None, size=0, etag=None, sha256=None, content_type=None,
                                   metadata={}, delete_marker=True)
        return {"version_id": vid, "delete_marker": True}


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def list_objects(s, bucket: str, prefix: str = "", delimiter: str | None = None, start_after: str = "",
                       max_keys: int = 1000) -> dict:
    """S3 ListObjectsV2 semantics incl. delimiter -> common prefixes ("folders")."""
    contents, prefixes = [], []
    after = start_after
    like = _escape_like(prefix) + "%"
    while len(contents) + len(prefixes) < max_keys:
        rows = (await s.execute(text(
            "SELECT key, size, etag, content_type, version_id, created_at FROM objects WHERE bucket = :b AND is_latest "
            "AND NOT is_delete_marker AND key LIKE :p ESCAPE '\\' AND key > :a ORDER BY key LIMIT :n"),
            {"b": bucket, "p": like, "a": after, "n": max_keys + 1})).mappings().all()
        if not rows:
            break
        skipped_to = None
        for r in rows:
            if len(contents) + len(prefixes) >= max_keys:
                return {"contents": contents, "common_prefixes": prefixes, "is_truncated": True,
                        "next_start_after": after}
            rest = r["key"][len(prefix):]
            if delimiter and delimiter in rest:
                cp = prefix + rest.split(delimiter, 1)[0] + delimiter
                prefixes.append(cp)
                after = skipped_to = cp + "\U0010ffff"   # jump past every key under this "folder"
                break
            contents.append(dict(r))
            after = r["key"]
        if skipped_to is None and len(rows) <= max_keys:
            break
    return {"contents": contents, "common_prefixes": prefixes, "is_truncated": False, "next_start_after": None}


async def list_versions(s, bucket: str, prefix: str = "", max_keys: int = 1000) -> list[dict]:
    rows = (await s.execute(text(
        "SELECT key, version_id, is_latest, is_delete_marker, size, etag, created_at FROM objects WHERE bucket = :b "
        "AND key LIKE :p ESCAPE '\\' ORDER BY key, created_at DESC, id DESC LIMIT :n"),
        {"b": bucket, "p": _escape_like(prefix) + "%", "n": max_keys})).mappings().all()
    return [dict(r) for r in rows]


# ---- multipart ----------------------------------------------------------------------------------
async def initiate_multipart(s, bucket: dict, key: str, content_type: str | None, metadata: dict, who: str) -> str:
    upload_id = uuid.uuid4().hex
    await s.execute(text("INSERT INTO multipart_uploads (upload_id, bucket, key, content_type, user_metadata, initiated_by) "
                         "VALUES (:u, :b, :k, :ct, CAST(:md AS jsonb), :w)"),
                    {"u": upload_id, "b": bucket["name"], "k": key, "ct": content_type, "md": json.dumps(metadata),
                     "w": who})
    return upload_id


async def _get_upload(s, bucket: str, upload_id: str) -> dict:
    row = (await s.execute(text("SELECT * FROM multipart_uploads WHERE upload_id = :u AND bucket = :b"),
                           {"u": upload_id, "b": bucket})).mappings().first()
    if row is None:
        raise NotFound("upload not found", details={"code": "NoSuchUpload"})
    return dict(row)


async def upload_part(sm, storage, bucket: dict, upload_id: str, part_number: int, body, *, max_bytes: int,
                      content_md5: str | None) -> dict:
    if not 1 <= part_number <= 10000:
        raise InvalidPart("part number must be 1..10000")
    async with sm() as s:
        await _get_upload(s, bucket["name"], upload_id)
    blob_key = new_blob_key()
    try:
        info = await storage.put(blob_key, HashingStream(body, max_bytes))
        _verify_digests(info, content_md5, None, None)
        async with sm() as s, s.begin():
            await _get_upload(s, bucket["name"], upload_id)
            if bucket["quota_bytes"] is not None:
                # Same bucket lock as PUT: concurrent part uploads must not all pass the check (found in review).
                await s.execute(text("SELECT 1 FROM buckets WHERE name = :b FOR UPDATE"), {"b": bucket["name"]})
                await _check_quota(s, bucket, info.size)
            old = (await s.execute(text("SELECT blob_key FROM multipart_parts WHERE upload_id = :u AND part_number = :n"),
                                   {"u": upload_id, "n": part_number})).scalar()
            # Re-uploading a part number replaces it (clients retry failed parts).
            await s.execute(text(
                "INSERT INTO multipart_parts (upload_id, part_number, size, etag, blob_key) VALUES (:u, :n, :sz, :e, :bk) "
                "ON CONFLICT (upload_id, part_number) DO UPDATE SET size = EXCLUDED.size, etag = EXCLUDED.etag, "
                "blob_key = EXCLUDED.blob_key, uploaded_at = now()"),
                {"u": upload_id, "n": part_number, "sz": info.size, "e": info.md5, "bk": blob_key})
            await _queue_blob_deletion(s, old)
    except TooLarge as exc:
        await storage.delete(blob_key)
        raise EntityTooLarge(str(exc)) from None
    except BaseException:
        await storage.delete(blob_key)
        raise
    return {"part_number": part_number, "etag": info.md5, "size": info.size}


async def complete_multipart(sm, storage, bucket: dict, upload_id: str, parts: list[dict], min_part: int) -> dict:
    async with sm() as s:
        up = await _get_upload(s, bucket["name"], upload_id)
        stored = {r.part_number: r for r in (await s.execute(text(
            "SELECT part_number, size, etag, blob_key FROM multipart_parts WHERE upload_id = :u"), {"u": upload_id})).all()}
    if not parts:
        raise InvalidPart("at least one part is required")
    numbers = [p["part_number"] for p in parts]
    if numbers != sorted(numbers) or len(set(numbers)) != len(numbers):
        raise InvalidPart("parts must be listed in ascending order without duplicates", details={"code": "InvalidPartOrder"})
    chosen = []
    for i, p in enumerate(parts):
        st = stored.get(p["part_number"])
        if st is None or st.etag != p["etag"].strip('"'):
            raise InvalidPart(f"part {p['part_number']} missing or ETag mismatch")
        if i < len(parts) - 1 and st.size < min_part:
            raise InvalidPart(f"part {p['part_number']} is {st.size} bytes; all parts except the last must be "
                              f">= {min_part}", details={"code": "EntityTooSmall"})
        chosen.append(st)
    # S3-style multipart ETag: md5 of the concatenated BINARY md5s of the parts, suffixed with the count.
    # (So a multipart ETag is NOT the md5 of the whole object -- a classic interview gotcha.)
    etag = hashlib.md5(b"".join(bytes.fromhex(p.etag) for p in chosen)).hexdigest() + f"-{len(chosen)}"

    async def concatenated():
        for p in chosen:
            async for chunk in storage.get(p.blob_key):
                yield chunk

    final_blob = new_blob_key()
    info = await storage.put(final_blob, HashingStream(concatenated(), sum(p.size for p in chosen)))
    try:
        async with sm() as s, s.begin():
            await s.execute(text(key_lock_sql()), {"b": bucket["name"], "k": up["key"]})
            if bucket["quota_bytes"] is not None:
                await s.execute(text("SELECT 1 FROM buckets WHERE name = :b FOR UPDATE"), {"b": bucket["name"]})
                # Check BEFORE deleting the upload: parts still count as used, the object replaces them, so the
                # net change is final size - all part sizes. (Checking after the cascade delete subtracted the
                # parts twice, so the check could never fail -- found in review.)
                await _check_quota(s, bucket, info.size - sum(st.size for st in stored.values()))
            deleted = await s.execute(text("DELETE FROM multipart_uploads WHERE upload_id = :u RETURNING upload_id"),
                                      {"u": upload_id})
            if deleted.first() is None:
                raise Conflict("upload was completed or aborted concurrently")
            for st in stored.values():          # parts (incl. unused ones) are no longer needed
                await _queue_blob_deletion(s, st.blob_key)
            vid = await commit_version(s, bucket, up["key"], blob_key=final_blob, size=info.size, etag=etag,
                                       sha256=info.sha256, content_type=up["content_type"], metadata=up["user_metadata"])
    except BaseException:
        await storage.delete(final_blob)
        raise
    return {"key": up["key"], "version_id": vid, "etag": etag, "size": info.size, "parts": len(chosen)}


async def abort_multipart(s, bucket: str, upload_id: str) -> None:
    await _get_upload(s, bucket, upload_id)
    blobs = (await s.execute(text("SELECT blob_key FROM multipart_parts WHERE upload_id = :u"), {"u": upload_id})).scalars().all()
    await s.execute(text("DELETE FROM multipart_uploads WHERE upload_id = :u"), {"u": upload_id})
    for b in blobs:
        await _queue_blob_deletion(s, b)
