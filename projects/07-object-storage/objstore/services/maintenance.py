"""Lifecycle rules, garbage collection, usage analytics."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from .objects import _queue_blob_deletion, abort_multipart, delete_object

log = logging.getLogger(__name__)


async def run_lifecycle(sm, storage, now: datetime | None = None) -> dict:
    """Apply every bucket's rules. Idempotent: running twice does nothing extra."""
    now = now or datetime.now(timezone.utc)
    out = {"expired_current": 0, "expired_noncurrent": 0, "removed_delete_markers": 0, "aborted_uploads": 0}
    async with sm() as s:
        rules = (await s.execute(text("SELECT r.*, b.versioning, b.quota_bytes, b.owner_key, b.public_read "
                                      "FROM lifecycle_rules r JOIN buckets b ON b.name = r.bucket"))).mappings().all()
    for r in rules:
        bucket = {"name": r["bucket"], "versioning": r["versioning"], "quota_bytes": r["quota_bytes"]}
        like = r["prefix"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        if r["expiration_days"] is not None:
            cutoff = now - timedelta(days=r["expiration_days"])
            async with sm() as s:
                keys = (await s.execute(text(
                    "SELECT key FROM objects WHERE bucket = :b AND is_latest AND NOT is_delete_marker "
                    "AND key LIKE :p ESCAPE '\\' AND created_at < :c"), {"b": r["bucket"], "p": like, "c": cutoff})).scalars().all()
            for k in keys:   # same semantics as a user DELETE: versioned buckets get a delete marker
                await delete_object(sm, storage, bucket, k, None)
                out["expired_current"] += 1
        if r["noncurrent_expiration_days"] is not None:
            cutoff = now - timedelta(days=r["noncurrent_expiration_days"])
            async with sm() as s, s.begin():
                # "Noncurrent since" = when the next newer version was created (that's when this one stopped
                # being current), computed with a window function.
                rows = (await s.execute(text(
                    "DELETE FROM objects WHERE id IN ("
                    "  SELECT id FROM (SELECT id, is_latest, lag(created_at) OVER (PARTITION BY key ORDER BY created_at DESC, id DESC)"
                    "    AS noncurrent_since FROM objects WHERE bucket = :b AND key LIKE :p ESCAPE '\\') v"
                    "  WHERE NOT is_latest AND noncurrent_since < :c) RETURNING blob_key"),
                    {"b": r["bucket"], "p": like, "c": cutoff})).scalars().all()
                for blob in rows:
                    await _queue_blob_deletion(s, blob)
                out["expired_noncurrent"] += len(rows)
                # A delete marker that is the ONLY remaining version is pointless ("expired object delete marker").
                res = await s.execute(text(
                    "DELETE FROM objects o WHERE bucket = :b AND is_delete_marker AND is_latest AND key LIKE :p ESCAPE '\\' "
                    "AND NOT EXISTS (SELECT 1 FROM objects x WHERE x.bucket = o.bucket AND x.key = o.key AND x.id <> o.id)"),
                    {"b": r["bucket"], "p": like})
                out["removed_delete_markers"] += res.rowcount
        if r["abort_multipart_days"] is not None:
            cutoff = now - timedelta(days=r["abort_multipart_days"])
            async with sm() as s, s.begin():
                ids = (await s.execute(text("SELECT upload_id FROM multipart_uploads WHERE bucket = :b AND key LIKE :p "
                                            "ESCAPE '\\' AND initiated_at < :c"),
                                       {"b": r["bucket"], "p": like, "c": cutoff})).scalars().all()
                for uid in ids:
                    await abort_multipart(s, r["bucket"], uid)
                out["aborted_uploads"] += len(ids)
    return out


async def run_gc(sm, storage, orphan_grace_seconds: int, deletion_grace_seconds: int = 300) -> dict:
    """1) delete blobs queued in blob_deletions (only after deletion_grace_seconds, so a slow GET that
    started before an overwrite/delete can finish streaming); 2) delete ORPHAN blobs: present in storage,
    older than the grace period, referenced by nothing (crash between blob write and metadata commit).
    One failing delete doesn't abort the run (it stays queued and is retried next time)."""
    deleted_queued = failed = 0
    async with sm() as s:
        queued = (await s.execute(text("SELECT blob_key FROM blob_deletions WHERE queued_at < now() - make_interval(secs => :g) "
                                       "ORDER BY queued_at LIMIT 10000"), {"g": deletion_grace_seconds})).scalars().all()
    for b in queued:
        try:
            async with sm() as s:
                still_used = await s.scalar(text("SELECT 1 FROM objects WHERE blob_key = :b UNION ALL "
                                                 "SELECT 1 FROM multipart_parts WHERE blob_key = :b LIMIT 1"), {"b": b})
            if not still_used:
                await storage.delete(b)
                deleted_queued += 1
            async with sm() as s, s.begin():
                await s.execute(text("DELETE FROM blob_deletions WHERE blob_key = :b"), {"b": b})
        except Exception:
            failed += 1
            log.exception("gc_delete_failed", extra={"blob_key": b})
    candidates = await storage.list_older_than(orphan_grace_seconds)
    orphans = 0
    async with sm() as s:
        referenced = set((await s.execute(text("SELECT blob_key FROM objects WHERE blob_key IS NOT NULL UNION "
                                               "SELECT blob_key FROM multipart_parts"))).scalars().all())
    for name in candidates:
        if name not in referenced:
            await storage.delete_any(name)
            orphans += 1
    if orphans:
        log.warning("gc_removed_orphan_blobs", extra={"count": orphans})
    out = {"deleted_queued_blobs": deleted_queued, "deleted_orphans": orphans}
    if failed:
        out["failed"] = failed
    return out


async def bucket_stats(s, bucket: str) -> dict:
    row = (await s.execute(text(
        "SELECT count(*) FILTER (WHERE is_latest AND NOT is_delete_marker) AS current_objects, "
        "coalesce(sum(size) FILTER (WHERE is_latest AND NOT is_delete_marker), 0) AS current_bytes, "
        "count(*) FILTER (WHERE NOT is_delete_marker) AS all_versions, "
        "coalesce(sum(size), 0) AS stored_bytes, "
        "count(*) FILTER (WHERE is_delete_marker) AS delete_markers, "
        "count(*) FILTER (WHERE NOT is_latest AND NOT is_delete_marker) AS noncurrent_versions "
        "FROM objects WHERE bucket = :b"), {"b": bucket})).mappings().one()
    mp = (await s.execute(text(
        "SELECT count(DISTINCT u.upload_id) AS uploads, coalesce(sum(p.size), 0) AS bytes FROM multipart_uploads u "
        "LEFT JOIN multipart_parts p ON p.upload_id = u.upload_id WHERE u.bucket = :b"), {"b": bucket})).mappings().one()
    by_type = (await s.execute(text(
        "SELECT coalesce(content_type, 'unknown') AS content_type, count(*) AS objects, sum(size) AS bytes FROM objects "
        "WHERE bucket = :b AND is_latest AND NOT is_delete_marker GROUP BY 1 ORDER BY 3 DESC LIMIT 10"),
        {"b": bucket})).mappings().all()
    largest = (await s.execute(text(
        "SELECT key, size FROM objects WHERE bucket = :b AND is_latest AND NOT is_delete_marker ORDER BY size DESC LIMIT 5"),
        {"b": bucket})).mappings().all()
    quota = await s.scalar(text("SELECT quota_bytes FROM buckets WHERE name = :b"), {"b": bucket})
    return {"bucket": bucket, **dict(row), "incomplete_multipart_uploads": mp["uploads"],
            "incomplete_multipart_bytes": mp["bytes"], "quota_bytes": quota,
            "quota_used_pct": round(100 * (row["stored_bytes"] + mp["bytes"]) / quota, 2) if quota else None,
            "by_content_type": [dict(x) for x in by_type], "largest_objects": [dict(x) for x in largest]}
