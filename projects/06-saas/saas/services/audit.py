"""Audit log: written in the SAME transaction as the action it describes, so you can never have
an action without its audit row (or an audit row for an action that rolled back)."""
from __future__ import annotations

import json

from sqlalchemy import text


async def record(s, principal, action: str, target_type: str | None = None, target_id=None, **metadata) -> None:
    await s.execute(text(
        "INSERT INTO audit_logs (tenant_id, actor_user_id, actor_api_key_id, action, target_type, target_id, "
        "metadata, ip, request_id) VALUES (:t, :u, :k, :a, :tt, :ti, CAST(:m AS jsonb), :ip, :rid)"),
        {"t": principal.tenant_id, "u": principal.user_id, "k": principal.api_key_id, "a": action,
         "tt": target_type, "ti": str(target_id) if target_id is not None else None,
         "m": json.dumps(metadata, default=str), "ip": principal.ip, "rid": principal.request_id})
