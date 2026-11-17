"""Tenant-aware background jobs.

Every job message carries tenant_id. The worker opens tenant_tx(tenant_id) BEFORE running the
handler, so RLS confines the job to that tenant's rows even if the handler's SQL forgets a filter.
(Missing this is a classic leak: a nightly job running with no/wrong tenant context.)
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from redis.asyncio import Redis
from sqlalchemy import text

from ..db.session import tenant_tx

log = logging.getLogger(__name__)
QUEUE = "saas:jobs"
HANDLERS = {}


def handler(name):
    def deco(fn):
        HANDLERS[name] = fn
        return fn
    return deco


async def enqueue(redis: Redis, tenant_id, kind: str, payload: dict) -> None:
    await redis.lpush(QUEUE, json.dumps({"tenant_id": str(tenant_id), "kind": kind, "payload": payload}))


@handler("project_report")
async def project_report(s, tenant_id, payload):
    # NOTE: no "WHERE tenant_id = ..." on purpose -- RLS scopes it.
    projects = await s.scalar(text("SELECT count(*) FROM projects"))
    members = await s.scalar(text("SELECT count(*) FROM memberships"))
    names = (await s.execute(text("SELECT name FROM projects ORDER BY name"))).scalars().all()
    result = {"projects": projects, "members": members, "project_names": names}
    await s.execute(text("UPDATE reports SET status = 'done', result = CAST(:r AS jsonb), finished_at = now() WHERE id = :i"),
                    {"r": json.dumps(result), "i": payload["report_id"]})
    return result


async def process_one(redis: Redis, sm, timeout: float = 1.0) -> bool:
    item = await redis.brpop(QUEUE, timeout=timeout)
    if item is None:
        return False
    msg = json.loads(item[1])
    fn = HANDLERS.get(msg["kind"])
    if fn is None:
        log.error("unknown_job", extra={"kind": msg["kind"]})
        return True
    try:
        async with tenant_tx(sm, msg["tenant_id"]) as s:
            status = await s.scalar(text("SELECT status FROM tenants WHERE id = :t"), {"t": msg["tenant_id"]})
            if status != "active":
                log.warning("job_skipped_suspended_tenant", extra={"tenant_id": msg["tenant_id"], "kind": msg["kind"]})
                return True
            await fn(s, msg["tenant_id"], msg["payload"])
    except Exception:
        log.exception("job_failed", extra={"kind": msg["kind"], "tenant_id": msg["tenant_id"]})
        if "report_id" in msg["payload"]:
            async with tenant_tx(sm, msg["tenant_id"]) as s:
                await s.execute(text("UPDATE reports SET status = 'failed', finished_at = :n WHERE id = :i"),
                                {"n": datetime.now(timezone.utc), "i": msg["payload"]["report_id"]})
    return True
