"""Regression tests for the review fixes (2026-11-17): crash takeovers must resume, not duplicate; a failed
webhook apply is retried on redelivery; sagas never cancel an order whose payment may still be charged; a
compensation that fails is reported; the ledger balances per currency; the audit trail is append-only."""
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from payments.services import idempotency
from payments.services import payments as pay_svc
from payments.services.provider import ProviderRejected
from payments.services.state import transition

from .conftest import ADMIN, pay, pay_body, system


async def crashed_idempotency_row(sm, merchant_id, key: str, path: str, body: bytes) -> None:
    """The first attempt took the idempotency lock and died; the lock has already expired."""
    async with sm() as s, s.begin():
        await s.execute(text(
            "INSERT INTO idempotency_keys (merchant_id, key, request_method, request_path, request_hash, state, locked_until) "
            "VALUES (:m, :k, 'POST', :p, :h, 'in_progress', :u)"),
            {"m": merchant_id, "k": key, "p": path, "h": idempotency.request_hash("POST", path, body),
             "u": datetime.now(timezone.utc) - timedelta(seconds=1)})


async def test_payment_takeover_after_crash_resumes_the_same_payment(clean):
    async with system() as c:
        sm, prov = c.app.state.sm, c.app.state.provider
        body = json.dumps(pay_body(ref="crash-1")).encode()
        pid = pay_svc.id_for(c.merchant_id, "k-crash", "payment")
        # attempt 1: inserted the payment, moved to authorizing, reached the provider -- then the process died
        async with sm() as s, s.begin():
            await s.execute(text("INSERT INTO payments (id, merchant_id, merchant_reference, amount, currency, status, payment_method, provider) "
                                 "VALUES (:i, :m, 'crash-1', 10000, 'INR', 'created', 'tok_visa', 'mockpay')"), {"i": pid, "m": c.merchant_id})
            await transition(s, pid, {"created"}, "authorizing", "attempt 1")
        await prov.authorize(10_000, "INR", "tok_visa", str(pid), idem=f"auth-{pid}")
        await crashed_idempotency_row(sm, c.merchant_id, "k-crash", "/payments", body)
        # attempt 2 (client retry, same key) takes over and RESUMES the same payment
        r = await c.post("/payments", content=body, headers={"Idempotency-Key": "k-crash", "content-type": "application/json"})
        assert r.status_code == 201, r.text
        assert r.json()["id"] == str(pid) and r.json()["status"] == "captured"
        async with sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM payments")) == 1
            assert await s.scalar(text("SELECT count(*) FROM provider.authorizations")) == 1    # charged once


async def test_refund_takeover_after_crash_does_not_refund_twice(clean):
    async with system() as c:
        sm, prov = c.app.state.sm, c.app.state.provider
        p = (await pay(c, "k1")).json()
        rid = pay_svc.id_for(c.merchant_id, "r-crash", "refund")
        path = f"/payments/{p['id']}/refunds"
        body = json.dumps({"amount": 4_000, "reason": "x"}).encode()
        async with sm() as s, s.begin():          # attempt 1: refund row + provider call, then crash
            await s.execute(text("INSERT INTO refunds (id, payment_id, amount, status, reason) VALUES (:i, :p, 4000, 'pending', 'x')"),
                            {"i": rid, "p": p["id"]})
        await prov.refund(p["provider_payment_id"], 4_000, str(rid), idem=f"refund-{rid}")
        await crashed_idempotency_row(sm, c.merchant_id, "r-crash", path, body)
        r = await c.post(path, content=body, headers={"Idempotency-Key": "r-crash", "content-type": "application/json"})
        assert r.status_code == 201 and r.json()["status"] == "succeeded", r.text
        final = (await c.get(f"/payments/{p['id']}")).json()
        assert final["amount_refunded"] == 4_000 and len(final["refunds"]) == 1
        async with sm() as s:
            assert await s.scalar(text("SELECT refunded FROM provider.authorizations")) == 4_000   # not 8000


def signed(evt: dict) -> tuple[bytes, dict]:
    body = json.dumps(evt).encode()
    ts = str(int(time.time()))
    sig = hmac.new(b"whsec_test", f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return body, {"x-provider-signature": f"t={ts},v1={sig}"}


async def test_webhook_whose_first_apply_failed_is_applied_on_redelivery(clean):
    async with system() as c:
        sm = c.app.state.sm
        p = (await pay(c, "k1", capture=False)).json()
        async with sm() as s, s.begin():
            await transition(s, p["id"], {"authorized"}, "capturing", "capture in flight", {"amount": 10_000})
        evt = {"id": "pevt_retry1", "type": "authorization.captured", "created": int(time.time()),
               "data": {"id": p["provider_payment_id"], "captured": 10_000}}
        async with sm() as s, s.begin():          # delivery 1 recorded the event, then failed before applying it
            await s.execute(text("INSERT INTO provider_events (id, type, payload, outcome) VALUES (:i, :t, CAST(:p AS jsonb), 'received')"),
                            {"i": evt["id"], "t": evt["type"], "p": json.dumps(evt)})
        body, h = signed(evt)
        assert (await c.post("/webhooks/provider", content=body, headers=h)).json()["outcome"] == "applied"
        assert (await c.get(f"/payments/{p['id']}")).json()["status"] == "captured"
        assert (await c.post("/webhooks/provider", content=body, headers=h)).json()["outcome"] == "duplicate"
        async with sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM ledger_transactions WHERE kind = 'capture'")) == 1


async def test_saga_with_unknown_payment_outcome_does_not_cancel_the_order(clean):
    async with system(slow_seconds=0.6, timeout=0.2, retries=0) as c:
        await c.post("/admin/inventory?sku=book&available=5", headers=ADMIN)
        out = (await c.post("/checkout", json={"order_id": "U1", "items": [{"sku": "book", "qty": 2}], "amount": 5_000,
                                               "payment_method": "tok_slow"})).json()
        assert out["status"] == "failed" and out["reason"] == "payment_outcome_unknown"
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT available FROM inventory WHERE sku = 'book'")) == 3      # still held
            assert await s.scalar(text("SELECT status FROM reservations WHERE order_id = 'U1'")) == "held"
            assert await s.scalar(text("SELECT count(*) FROM refunds")) == 0


async def test_saga_whose_compensation_fails_is_reported_failed(clean):
    async with system() as c:
        await c.post("/admin/inventory?sku=book&available=5", headers=ADMIN)

        async def refund_rejected(*a, **kw):
            raise ProviderRejected(402, "refund declined")
        c.app.state.provider.refund = refund_rejected
        out = (await c.post("/checkout", json={"order_id": "F1", "items": [{"sku": "book", "qty": 1}], "amount": 2_500,
                                               "payment_method": "tok_visa", "simulate_shipping_failure": True})).json()
        assert out["status"] == "failed"                    # NOT "compensated": the customer was not refunded
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT status FROM sagas WHERE order_id = 'F1'")) == "failed"
            assert await s.scalar(text("SELECT s.status FROM saga_steps s JOIN sagas g ON g.id = s.saga_id "
                                       "WHERE g.order_id = 'F1' AND s.step = 'charge_payment'")) == "failed"


async def test_ledger_rejects_transaction_that_balances_only_across_currencies(clean):
    async with system() as c:
        await pay(c, "k1", ref="o1", currency="INR")
        await pay(c, "k2", ref="o2", currency="USD")
        sm = c.app.state.sm
        with pytest.raises(DBAPIError, match="unbalanced in"):
            async with sm() as s, s.begin():
                tid = await s.scalar(text("INSERT INTO ledger_transactions (kind, idempotency_ref) VALUES ('adjustment', 'fx') RETURNING id"))
                for cur, amt in (("INR", 500), ("USD", -500)):          # sums to 0, but creates value from nothing
                    acct = await s.scalar(text("SELECT id FROM ledger_accounts WHERE currency = :c LIMIT 1"), {"c": cur})
                    await s.execute(text("INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES (:t, :a, :x)"),
                                    {"t": tid, "a": acct, "x": amt})
        with pytest.raises(DBAPIError, match="append-only"):
            async with sm() as s, s.begin():
                await s.execute(text("UPDATE payment_events SET reason = 'rewritten'"))
