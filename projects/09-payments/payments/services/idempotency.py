"""Idempotency keys (Stripe semantics) for POST endpoints.

  first request with key K           -> row (in_progress, request hash) inserted, request runs, response stored
  same K, same request, completed    -> stored response replayed (no second charge)
  same K, DIFFERENT request          -> 422 (a client bug: keys are per operation)
  same K while the first is running  -> 409 (retry later)
  same K, first attempt crashed      -> lock expired: this attempt takes over (operations below are safe to resume
                                        because provider calls use deterministic idempotency keys too)
Deterministic 4xx outcomes are stored (replays give the same error); 5xx are NOT stored, so the client can retry.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from bpcommon.errors import AppError, Conflict


class IdempotencyMismatch(AppError):
    status_code, code = 422, "idempotency_key_reused"


def request_hash(method: str, path: str, body: bytes) -> str:
    return hashlib.sha256(method.encode() + b" " + path.encode() + b"\n" + body).hexdigest()


async def begin(sm, merchant_id, key: str, method: str, path: str, body: bytes, lock_seconds: float):
    """Returns None (go ahead) or (status, body) to replay."""
    h = request_hash(method, path, body)
    until = datetime.now(timezone.utc) + timedelta(seconds=lock_seconds)
    async with sm() as s, s.begin():
        inserted = await s.scalar(text(
            "INSERT INTO idempotency_keys (merchant_id, key, request_method, request_path, request_hash, state, locked_until) "
            "VALUES (:m, :k, :me, :p, :h, 'in_progress', :u) ON CONFLICT DO NOTHING RETURNING key"),
            {"m": merchant_id, "k": key, "me": method, "p": path, "h": h, "u": until})
        if inserted:
            return None
        row = (await s.execute(text("SELECT * FROM idempotency_keys WHERE merchant_id = :m AND key = :k FOR UPDATE"),
                               {"m": merchant_id, "k": key})).mappings().one()
        if row["request_hash"] != h:
            raise IdempotencyMismatch("this Idempotency-Key was used with a different request")
        if row["state"] == "completed":
            return row["response_status"], row["response_body"]
        if row["locked_until"] > datetime.now(timezone.utc):
            raise Conflict("a request with this Idempotency-Key is still in progress; retry later",
                           details={"code": "idempotency_in_progress"})
        await s.execute(text("UPDATE idempotency_keys SET locked_until = :u WHERE merchant_id = :m AND key = :k"),
                        {"u": until, "m": merchant_id, "k": key})
        return None


async def complete(sm, merchant_id, key: str, status: int, body: dict) -> None:
    async with sm() as s, s.begin():
        await s.execute(text("UPDATE idempotency_keys SET state = 'completed', response_status = :s, "
                             "response_body = CAST(:b AS jsonb), locked_until = NULL WHERE merchant_id = :m AND key = :k"),
                        {"s": status, "b": json.dumps(body, default=str), "m": merchant_id, "k": key})


async def abandon(sm, merchant_id, key: str) -> None:
    async with sm() as s, s.begin():
        await s.execute(text("DELETE FROM idempotency_keys WHERE merchant_id = :m AND key = :k AND state = 'in_progress'"),
                        {"m": merchant_id, "k": key})
