"""Billing provider abstraction.

The app talks to `BillingProvider`, never to Stripe/Razorpay SDKs directly. Swapping providers (or
running tests offline) means another implementation, not changes across the codebase.
MockBillingProvider behaves like a real one: checkout sessions, and SIGNED webhooks for outcomes.

Webhook processing is idempotent (billing_events.id = provider event id, primary key) because
providers deliver at-least-once -- the same 'subscription.updated' can arrive twice.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from bpcommon.errors import Unauthorized, Unprocessable

from ..core.plans import PLANS
from ..db.session import tenant_tx


@dataclass
class CheckoutSession:
    id: str
    url: str


@dataclass
class BillingEvent:
    id: str
    type: str
    created: int
    tenant_id: str
    plan: str | None
    status: str | None
    customer_id: str | None
    subscription_id: str | None


class BillingProvider(Protocol):
    name: str

    async def create_checkout(self, tenant_id: str, plan: str) -> CheckoutSession: ...

    def verify_and_parse(self, body: bytes, signature: str | None) -> BillingEvent: ...


class MockBillingProvider:
    name = "mock"

    def __init__(self, webhook_secret: str):
        self.secret = webhook_secret.encode()
        self.sessions: dict[str, dict] = {}

    async def create_checkout(self, tenant_id: str, plan: str) -> CheckoutSession:
        sid = "cs_" + secrets.token_hex(8)
        self.sessions[sid] = {"tenant_id": tenant_id, "plan": plan}
        return CheckoutSession(sid, f"/billing/mock/checkout/{sid}")

    def sign(self, body: bytes, ts: int | None = None) -> str:
        ts = ts or int(time.time())
        mac = hmac.new(self.secret, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
        return f"t={ts},v1={mac}"

    def complete(self, session_id: str) -> tuple[bytes, str]:
        """Simulate the customer paying: returns the (body, signature) the provider would POST to us."""
        sess = self.sessions.pop(session_id, None)
        if sess is None:
            raise Unprocessable("unknown checkout session")
        evt = {"id": "evt_" + secrets.token_hex(8), "type": "subscription.updated", "created": int(time.time() * 1000),
               "data": {"tenant_id": sess["tenant_id"], "plan": sess["plan"], "status": "active",
                        "customer_id": "cus_" + sess["tenant_id"][:8], "subscription_id": "sub_" + secrets.token_hex(6)}}
        body = json.dumps(evt).encode()
        return body, self.sign(body)

    def verify_and_parse(self, body: bytes, signature: str | None, tolerance: int = 300) -> BillingEvent:
        try:
            parts = dict(p.split("=", 1) for p in (signature or "").split(","))
            ts = int(parts["t"])
        except (ValueError, KeyError):
            raise Unauthorized("missing or malformed signature") from None
        expected = hmac.new(self.secret, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, parts.get("v1", "")) or abs(time.time() - ts) > tolerance:
            raise Unauthorized("invalid signature")
        e = json.loads(body)
        d = e["data"]
        return BillingEvent(e["id"], e["type"], int(e.get("created", 0)), d["tenant_id"], d.get("plan"), d.get("status"),
                            d.get("customer_id"), d.get("subscription_id"))


async def apply_event(sm, provider_name: str, evt: BillingEvent, raw: bytes) -> bool:
    """Returns False if the event was already processed (duplicate delivery).

    Everything happens in ONE transaction (dedupe row, plan, subscription, audit): a crash can't leave a
    half-applied event that a retry would then skip as "duplicate" (found in review). Events older than the
    one already applied are recorded but ignored (providers deliver out of order)."""
    from datetime import datetime, timezone
    if evt.plan is not None and evt.plan not in PLANS:
        raise Unprocessable(f"unknown plan {evt.plan}")
    async with tenant_tx(sm, evt.tenant_id) as s:
        try:
            async with s.begin_nested():
                await s.execute(text("INSERT INTO billing_events (id, type, payload) VALUES (:i, :t, CAST(:p AS jsonb))"),
                                {"i": evt.id, "t": evt.type, "p": raw.decode()})
        except IntegrityError:
            return False
        if evt.type != "subscription.updated":
            return True
        event_at = datetime.fromtimestamp(evt.created / 1000, tz=timezone.utc)
        newer = await s.scalar(text("SELECT 1 FROM subscriptions WHERE tenant_id = :t AND provider_event_at > :e"),
                               {"t": evt.tenant_id, "e": event_at})
        if newer:
            return True   # stale event: a later one was already applied
        plan = evt.plan if evt.status == "active" else "free"
        await s.execute(text("UPDATE tenants SET plan = :p WHERE id = :t"), {"p": plan, "t": evt.tenant_id})
        await s.execute(text(
            "INSERT INTO subscriptions (tenant_id, plan, status, provider, provider_customer_id, provider_subscription_id, "
            "provider_event_at) VALUES (:t, :p, :st, :pr, :c, :sub, :e) ON CONFLICT (tenant_id) DO UPDATE SET "
            "plan = EXCLUDED.plan, status = EXCLUDED.status, provider = EXCLUDED.provider, "
            "provider_customer_id = EXCLUDED.provider_customer_id, provider_subscription_id = EXCLUDED.provider_subscription_id, "
            "provider_event_at = EXCLUDED.provider_event_at, updated_at = now()"),
            {"t": evt.tenant_id, "p": evt.plan, "st": evt.status, "pr": provider_name, "c": evt.customer_id,
             "sub": evt.subscription_id, "e": event_at})
        await s.execute(text("INSERT INTO audit_logs (tenant_id, action, target_type, metadata) "
                             "VALUES (:t, 'billing.plan_changed', 'subscription', CAST(:m AS jsonb))"),
                        {"t": evt.tenant_id, "m": json.dumps({"plan": evt.plan, "status": evt.status, "event": evt.id})})
    return True
