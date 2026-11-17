import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from payments.services.money import fee_for

from .conftest import ADMIN, pay, system


def test_fee_rounding_half_up_in_minor_units():
    assert fee_for(10_000, 290, 30) == 320            # 2.90% of 100.00 = 2.90 + 0.30
    assert fee_for(1_017, 290, 30) == 59              # 29.493 -> 29 (+30)
    assert fee_for(1_018, 290, 30) == 60              # 29.522 -> 30 (+30)
    assert fee_for(50, 290, 30) == 31 and fee_for(10, 290, 30) == 10   # never more than the amount


async def balances(c):
    return {b["account"]: b["balance"] for b in (await c.get("/ledger/balances")).json()["balances"]}


async def test_authorize_and_capture_books_balanced_ledger(clean):
    async with system() as c:
        r = await pay(c, "k1")
        p = r.json()
        assert r.status_code == 201 and p["status"] == "captured" and p["amount_captured"] == 10_000 and p["fee"] == 320
        assert await balances(c) == {"merchant_payable": -9_680, "platform_fee_revenue": -320, "provider_receivable": 10_000}
        assert (await c.get("/admin/ledger/trial-balance", headers=ADMIN)).json()["sum_of_all_entries"] == 0
        events = [e["to_status"] for e in (await c.get(f"/payments/{p['id']}")).json()["events"]]
        assert events == ["authorizing", "authorized", "capturing", "captured"]


async def test_partial_capture_and_refunds(clean):
    async with system() as c:
        p = (await pay(c, "k1", capture=False)).json()
        assert p["status"] == "authorized"
        cap = (await c.post(f"/payments/{p['id']}/capture", json={"amount": 6_000}, headers={"Idempotency-Key": "c1"})).json()
        assert cap["status"] == "captured" and cap["amount_captured"] == 6_000
        r1 = await c.post(f"/payments/{p['id']}/refunds", json={"amount": 2_000}, headers={"Idempotency-Key": "r1"})
        assert r1.json()["status"] == "succeeded"
        over = await c.post(f"/payments/{p['id']}/refunds", json={"amount": 4_001}, headers={"Idempotency-Key": "r2"})
        assert over.status_code == 422
        await c.post(f"/payments/{p['id']}/refunds", json={"amount": 4_000}, headers={"Idempotency-Key": "r3"})
        final = (await c.get(f"/payments/{p['id']}")).json()
        assert final["status"] == "refunded" and final["amount_refunded"] == 6_000
        b = await balances(c)
        assert b["provider_receivable"] == 0 and b["merchant_payable"] == fee_for(6_000, 290, 30)   # merchant owes back the fee
        assert (await c.get("/admin/ledger/trial-balance", headers=ADMIN)).json()["sum_of_all_entries"] == 0


async def test_declines_and_retry_after_decline(clean):
    async with system() as c:
        d = (await pay(c, "k1", token="tok_insufficient_funds")).json()
        assert d["status"] == "declined" and d["decline_code"] == "insufficient_funds"
        ok = (await pay(c, "k2", token="tok_visa")).json()            # same order, new attempt after decline
        assert ok["status"] == "captured"
        assert await balances(c) != {}


async def test_duplicate_order_payment_blocked(clean):
    async with system() as c:
        assert (await pay(c, "k1")).status_code == 201
        dup = await pay(c, "k2")                                       # different key, same order: double charge!
        assert dup.status_code == 409 and dup.json()["error"]["code"] == "duplicate_payment"


async def test_idempotency_key_semantics(clean):
    async with system() as c:
        a = await pay(c, "same-key")
        b = await pay(c, "same-key")
        assert a.json() == b.json() and b.headers.get("idempotent-replayed") == "true"
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM provider.authorizations")) == 1   # charged once
        diff = await pay(c, "same-key", amount=999)
        assert diff.status_code == 422 and diff.json()["error"]["code"] == "idempotency_key_reused"
        rs = await asyncio.gather(*[pay(c, "race-key", ref="order-2") for _ in range(5)])
        codes = sorted(r.status_code for r in rs)
        assert codes.count(201) >= 1 and set(codes) <= {201, 409}
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM payments WHERE merchant_reference = 'order-2'")) == 1


async def test_concurrent_captures_capture_once(clean):
    async with system() as c:
        p = (await pay(c, "k1", capture=False)).json()
        rs = await asyncio.gather(*[c.post(f"/payments/{p['id']}/capture", json={}, headers={"Idempotency-Key": f"cap-{i}"})
                                    for i in range(5)])
        assert sum(r.status_code == 200 and r.json()["status"] == "captured" for r in rs) == 1
        assert all(r.status_code in (200, 409) for r in rs)
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM ledger_transactions WHERE kind = 'capture'")) == 1


async def test_concurrent_refunds_cannot_over_refund(clean):
    async with system() as c:
        p = (await pay(c, "k1")).json()
        rs = await asyncio.gather(*[c.post(f"/payments/{p['id']}/refunds", json={"amount": 3_000}, headers={"Idempotency-Key": f"r{i}"})
                                    for i in range(6)])
        ok = [r for r in rs if r.status_code == 201 and r.json()["status"] == "succeeded"]
        assert len(ok) == 3                                            # 3 x 3000 <= 10000, a 4th would exceed
        assert (await c.get(f"/payments/{p['id']}")).json()["amount_refunded"] == 9_000


async def test_ledger_invariants_enforced_by_database(clean):
    async with system() as c:
        await pay(c, "k1")
        sm = c.app.state.sm
        with pytest.raises(DBAPIError, match="unbalanced"):
            async with sm() as s, s.begin():
                tid = await s.scalar(text("INSERT INTO ledger_transactions (kind, idempotency_ref) VALUES ('adjustment', 'bad') RETURNING id"))
                acct = await s.scalar(text("SELECT id FROM ledger_accounts LIMIT 1"))
                await s.execute(text("INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES (:t, :a, 500)"),
                                {"t": tid, "a": acct})
        with pytest.raises(DBAPIError, match="append-only"):
            async with sm() as s, s.begin():
                await s.execute(text("UPDATE ledger_entries SET amount = amount * 2"))


async def test_provider_flaky_500_is_retried_safely(clean):
    async with system() as c:
        p = (await pay(c, "k1", token="tok_flaky")).json()
        assert p["status"] == "captured"
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM provider.authorizations")) == 1


async def test_capture_rejected_keeps_payment_authorized(clean):
    async with system() as c:
        p = (await pay(c, "k1", token="tok_capture_fails")).json()
        assert p["status"] == "authorized" and "402" in p["last_error"]
        assert await balances(c) == {}


async def test_api_requires_merchant_key_and_admin_token(clean):
    async with system() as c:
        assert (await c.get("/payments", headers={"Authorization": "Bearer nope"})).status_code == 401
        assert (await c.post("/admin/merchants", json={"name": "x"})).status_code == 403
        assert (await c.post("/payments", json={"amount": 1, "currency": "INR", "payment_method": "tok_visa",
                                                "merchant_reference": "x"})).status_code == 422   # Idempotency-Key required
