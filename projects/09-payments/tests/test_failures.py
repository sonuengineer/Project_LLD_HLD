"""Ambiguous outcomes, crashes, webhooks, recovery, reconciliation, saga."""
import asyncio
import hashlib
import hmac
import json
import time
from datetime import date, datetime, timezone

from sqlalchemy import text

from payments.services.state import transition

from .conftest import ADMIN, pay, system


async def test_timeout_retried_with_same_key_resolves_immediately(clean):
    """A timeout followed by a retry with the SAME idempotency key: the provider returns the authorization it
    already recorded -- the ambiguity resolves inside the request, and there is still only one charge."""
    async with system(slow_seconds=0.6, timeout=0.2, retries=2) as c:
        p = (await pay(c, "k1", token="tok_slow", capture=False)).json()
        assert p["status"] == "authorized"
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM provider.authorizations")) == 1


async def test_timeout_is_not_treated_as_failure_and_recovery_resolves_it(clean):
    async with system(slow_seconds=0.6, timeout=0.2, retries=0) as c:      # no retry: outcome stays unknown
        p = (await pay(c, "k1", token="tok_slow", capture=False)).json()
        assert p["status"] == "requires_reconciliation"            # NOT failed: the charge may have happened
        await asyncio.sleep(0.7)
        async with c.app.state.sm() as s:                            # it DID happen at the provider
            assert await s.scalar(text("SELECT status FROM provider.authorizations")) == "authorized"
        out = (await c.post("/admin/recovery/run?stuck_after_seconds=0", headers=ADMIN)).json()
        assert out["resolved"] == 1
        fixed = (await c.get(f"/payments/{p['id']}")).json()
        assert fixed["status"] == "authorized" and fixed["provider_payment_id"]
        assert any("recovery" in e["reason"] for e in fixed["events"])


async def test_payment_unknown_to_provider_is_failed_by_recovery(clean):
    async with system() as c:
        sm = c.app.state.sm
        async with sm() as s, s.begin():                           # crashed right after persisting "authorizing"
            pid = await s.scalar(text("INSERT INTO payments (merchant_id, merchant_reference, amount, currency, status, "
                                      "payment_method, provider) VALUES (:m, 'lost', 100, 'INR', 'created', 'tok_visa', 'mockpay') RETURNING id"),
                                 {"m": c.merchant_id})
            await transition(s, pid, {"created"}, "authorizing", "test")
        await c.post("/admin/recovery/run?stuck_after_seconds=0", headers=ADMIN)
        assert (await c.get(f"/payments/{pid}")).json()["status"] == "failed"


async def test_crash_mid_capture_is_completed_by_recovery_exactly_once(clean):
    async with system() as c:
        p = (await pay(c, "k1", capture=False)).json()
        async with c.app.state.sm() as s, s.begin():               # crashed after moving to 'capturing'
            await transition(s, p["id"], {"authorized"}, "capturing", "test crash", {"amount": 10_000})
        for _ in range(2):                                          # running recovery twice must not double-book
            await c.post("/admin/recovery/run?stuck_after_seconds=0", headers=ADMIN)
        final = (await c.get(f"/payments/{p['id']}")).json()
        assert final["status"] == "captured"
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM ledger_transactions WHERE kind = 'capture'")) == 1
            assert await s.scalar(text("SELECT captured FROM provider.authorizations")) == 10_000


async def test_webhooks_are_verified_deduplicated_and_can_finalize_capture(clean):
    async with system() as c:
        p = (await pay(c, "k1", capture=False)).json()
        async with c.app.state.sm() as s, s.begin():
            await transition(s, p["id"], {"authorized"}, "capturing", "capture in flight", {"amount": 10_000})
        # the provider captures and its webhook beats our (lost) API response
        prov = c.app.state.provider
        await prov.capture(p["provider_payment_id"], 10_000, idem=f"capture-{p['id']}")
        for _ in range(50):
            if (await c.get(f"/payments/{p['id']}")).json()["status"] == "captured":
                break
            await asyncio.sleep(0.02)
        assert (await c.get(f"/payments/{p['id']}")).json()["status"] == "captured"
        evt = c.provider_app.state.events_sent[-1]
        body = json.dumps(evt).encode()
        ts = str(int(time.time()))
        sig = hmac.new(b"whsec_test", f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
        dup = await c.post("/webhooks/provider", content=body, headers={"x-provider-signature": f"t={ts},v1={sig}"})
        assert dup.json()["outcome"] == "duplicate"
        bad = await c.post("/webhooks/provider", content=body, headers={"x-provider-signature": f"t={ts},v1=deadbeef"})
        assert bad.status_code == 401
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT count(*) FROM ledger_transactions WHERE kind = 'capture'")) == 1


async def test_reconciliation_finds_drift_and_unrecorded_charges(clean):
    async with system(slow_seconds=0.5, timeout=0.2, retries=0) as c:
        ok = (await pay(c, "k1", ref="o1")).json()
        drifted = (await pay(c, "k2", ref="o2")).json()
        slow = (await pay(c, "k3", ref="o3", token="tok_slow")).json()       # ours: no provider id yet
        await asyncio.sleep(0.6)
        import httpx
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=c.provider_app), base_url="http://p") as p:
            await p.post(f"/test/drift/{drifted['provider_payment_id']}", json={"amount": 9_000})   # e.g. partial chargeback
        # Settlement days are UTC days (the DB buckets by UTC); a local date can be a different day.
        day = datetime.now(timezone.utc).date().isoformat()
        run = (await c.post(f"/admin/reconciliation/runs?day={day}", headers=ADMIN)).json()
        assert run["summary"] == {"matched": 1, "amount_mismatch": 1, "missing_internally": 1}
        detail = (await c.get(f"/admin/reconciliation/runs/{run['run_id']}", headers=ADMIN)).json()
        kinds = sorted(e["kind"] for e in detail["exceptions"])
        assert kinds == ["amount_mismatch", "missing_internally"]
        assert slow["status"] == "requires_reconciliation" and ok["status"] == "captured"


async def test_saga_success_and_compensation(clean):
    async with system() as c:
        await c.post("/admin/inventory?sku=book&available=5", headers=ADMIN)
        ok = (await c.post("/checkout", json={"order_id": "A1", "items": [{"sku": "book", "qty": 2}], "amount": 5_000,
                                              "payment_method": "tok_visa"})).json()
        assert ok["status"] == "completed"
        bad = (await c.post("/checkout", json={"order_id": "A2", "items": [{"sku": "book", "qty": 1}], "amount": 2_500,
                                               "payment_method": "tok_visa", "simulate_shipping_failure": True})).json()
        assert bad["status"] == "compensated"
        refunded = (await c.get(f"/payments/{bad['payment_id']}")).json()
        assert refunded["status"] == "refunded"                    # compensation: money returned
        nostock = (await c.post("/checkout", json={"order_id": "A3", "items": [{"sku": "book", "qty": 99}], "amount": 1,
                                                   "payment_method": "tok_visa"})).json()
        assert nostock["status"] == "compensated" and nostock["payment_id"] is None   # never charged
        async with c.app.state.sm() as s:
            assert await s.scalar(text("SELECT available FROM inventory WHERE sku = 'book'")) == 3   # 5 - 2 (A2 released)
            steps = (await s.execute(text("SELECT s.step, s.status FROM saga_steps s JOIN sagas g ON g.id = s.saga_id "
                                          "WHERE g.order_id = 'A2' ORDER BY step"))).all()
            assert [tuple(x) for x in steps] == [("charge_payment", "compensated"), ("reserve_inventory", "compensated")]
