"""Provider -> us webhooks: verify signature, dedupe by event id, apply idempotently.
Webhooks can arrive BEFORE the API response of the same operation, AFTER it, twice, or out of order, so every
handler is a compare-and-set that is a no-op when the state already reflects the event."""
from __future__ import annotations

import hashlib
import hmac
import json
import time

from sqlalchemy import text

from bpcommon.errors import Unauthorized

from .payments import finalize_capture, finalize_refund


def verify(secret: str, body: bytes, header: str | None, tolerance: int = 300) -> dict:
    try:
        parts = dict(p.split("=", 1) for p in (header or "").split(","))
        ts = int(parts["t"])
    except (ValueError, KeyError):
        raise Unauthorized("malformed signature header") from None
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts.get("v1", "")) or abs(time.time() - ts) > tolerance:
        raise Unauthorized("invalid provider signature")
    return json.loads(body)


async def handle(sm, evt: dict) -> str:
    """The event row is recorded first (outcome 'received') and its outcome set only AFTER the event was
    applied. A redelivery is a duplicate only if that earlier delivery finished; if it is still 'received'
    the first attempt crashed or failed half-way, so we apply again -- safe, because every handler below is
    an idempotent compare-and-set. (Before: any second delivery was dropped, so an apply that failed once
    was lost until recovery/reconciliation noticed.)"""
    async with sm() as s, s.begin():
        inserted = await s.scalar(text(
            "INSERT INTO provider_events (id, type, payload, outcome) VALUES (:i, :t, CAST(:p AS jsonb), 'received') "
            "ON CONFLICT (id) DO NOTHING RETURNING id"), {"i": evt["id"], "t": evt["type"], "p": json.dumps(evt)})
        if inserted is None:
            prev = await s.scalar(text("SELECT outcome FROM provider_events WHERE id = :i"), {"i": evt["id"]})
            if prev != "received":
                return "duplicate"
    outcome = "ignored"
    d = evt["data"]
    if evt["type"] == "authorization.captured":
        async with sm() as s, s.begin():
            p = (await s.execute(text("SELECT p.*, m.fee_bps, m.fee_fixed FROM payments p JOIN merchants m ON m.id = p.merchant_id "
                                      "WHERE p.provider_payment_id = :i FOR UPDATE OF p"), {"i": d["id"]})).mappings().first()
            if p is None:
                outcome = "unknown_payment"          # reconciliation will surface it
            elif p["status"] in ("capturing", "requires_reconciliation"):
                await finalize_capture(s, dict(p), d["captured"], {"fee_bps": p["fee_bps"], "fee_fixed": p["fee_fixed"]},
                                       {"capturing", "requires_reconciliation"}, "capture confirmed by webhook")
                outcome = "applied"
            else:
                outcome = f"noop_status_{p['status']}"
    elif evt["type"] == "refund.succeeded" and d.get("reference"):
        await finalize_refund(sm, d["reference"], d["id"])
        outcome = "applied"
    async with sm() as s, s.begin():
        await s.execute(text("UPDATE provider_events SET outcome = :o WHERE id = :i"), {"o": outcome, "i": evt["id"]})
    return outcome
