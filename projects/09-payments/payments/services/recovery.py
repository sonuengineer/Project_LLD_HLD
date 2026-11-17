"""Recovery worker: resolves payments stuck in an intermediate or ambiguous state by asking the provider.

  authorizing / requires_reconciliation(after auth)  -> look up by our reference (= payment id):
        found authorized -> authorized ; captured -> captured (+ledger) ; declined -> declined ; voided -> voided
        not found -> failed (the request never reached the provider; safe to tell the customer to retry)
  capturing / voiding / requires_reconciliation(after capture/void) -> RETRY with the same idempotency key:
        the provider either returns the original result or performs it now -- never twice
  refunds pending / requires_reconciliation -> retry with the same idempotency key
"""
from __future__ import annotations

import logging

from sqlalchemy import text

from .payments import AMBIGUOUS, finalize_capture, finalize_refund, get_payment
from .provider import ProviderRejected
from .state import transition

log = logging.getLogger(__name__)


async def _last_intent(s, payment_id) -> dict | None:
    return (await s.execute(text(
        "SELECT to_status, data FROM payment_events WHERE payment_id = :p AND to_status IN ('authorizing', 'capturing', 'voiding') "
        "ORDER BY id DESC LIMIT 1"), {"p": payment_id})).mappings().first()


async def run_recovery(sm, provider, stuck_after_seconds: float) -> dict:
    out = {"resolved": 0, "still_unknown": 0, "refunds_resolved": 0}
    async with sm() as s:
        stuck = (await s.execute(text(
            "SELECT p.id, p.status, m.fee_bps, m.fee_fixed FROM payments p JOIN merchants m ON m.id = p.merchant_id "
            "WHERE p.status IN ('authorizing', 'capturing', 'voiding', 'requires_reconciliation') "
            "AND p.updated_at < now() - make_interval(secs => :s)"), {"s": stuck_after_seconds})).mappings().all()
    for row in stuck:
        merchant = {"fee_bps": row["fee_bps"], "fee_fixed": row["fee_fixed"]}
        try:
            async with sm() as s:
                p = await get_payment(s, row["id"])
                intent = await _last_intent(s, row["id"])
            phase = intent["to_status"] if intent else "authorizing"
            if phase == "authorizing":
                found = await provider.find_by_reference(str(p["id"]))
                await _adopt_authorization(sm, p, found, merchant)
            elif phase == "capturing":
                amount = (intent["data"] or {}).get("amount") or p["amount_authorized"]
                try:
                    await provider.capture(p["provider_payment_id"], amount, idem=f"capture-{p['id']}")
                    async with sm() as s, s.begin():
                        await finalize_capture(s, p, amount, merchant, {"capturing", "requires_reconciliation"},
                                               "capture confirmed by recovery")
                except ProviderRejected as exc:
                    async with sm() as s, s.begin():
                        await transition(s, p["id"], {"capturing", "requires_reconciliation"}, "authorized",
                                         "capture rejected (recovery)", {"error": str(exc)})
            elif phase == "voiding":
                try:
                    await provider.void(p["provider_payment_id"], idem=f"void-{p['id']}")
                    async with sm() as s, s.begin():
                        await transition(s, p["id"], {"voiding", "requires_reconciliation"}, "voided", "void confirmed by recovery")
                except ProviderRejected:
                    async with sm() as s, s.begin():
                        await transition(s, p["id"], {"voiding", "requires_reconciliation"}, "authorized", "void rejected (recovery)")
            out["resolved"] += 1
        except AMBIGUOUS:
            out["still_unknown"] += 1        # provider still unreachable: try again next run
        except Exception:
            log.exception("recovery_failed", extra={"payment_id": str(row["id"])})
            out["still_unknown"] += 1
    async with sm() as s:
        refunds = (await s.execute(text(
            "SELECT r.id, r.amount, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id "
            "WHERE r.status IN ('pending', 'requires_reconciliation') AND r.updated_at < now() - make_interval(secs => :s)"),
            {"s": stuck_after_seconds})).mappings().all()
    for r in refunds:
        try:
            res = await provider.refund(r["provider_payment_id"], r["amount"], str(r["id"]), idem=f"refund-{r['id']}")
            await finalize_refund(sm, r["id"], res["id"])
            out["refunds_resolved"] += 1
        except AMBIGUOUS:
            out["still_unknown"] += 1
        except ProviderRejected:
            async with sm() as s, s.begin():
                await s.execute(text("UPDATE refunds SET status = 'failed', updated_at = now() WHERE id = :i"), {"i": r["id"]})
    return out


async def _adopt_authorization(sm, p: dict, found: list[dict], merchant: dict) -> None:
    expected = {"authorizing", "requires_reconciliation"}
    async with sm() as s, s.begin():
        if not found:
            await transition(s, p["id"], expected, "failed", "provider has no record (request never arrived)")
            return
        a = found[-1]
        if a["status"] == "declined":
            await transition(s, p["id"], expected, "declined", "declined (found by recovery)", provider_payment_id=a["id"])
        elif a["status"] == "voided":
            await transition(s, p["id"], expected, "voided", "voided (found by recovery)", provider_payment_id=a["id"])
        else:
            updated = await transition(s, p["id"], expected, "authorized", "authorized (found by recovery)",
                                       {"provider_id": a["id"]}, amount_authorized=a["amount"], provider_payment_id=a["id"])
            if a["status"] == "captured":
                await transition(s, p["id"], {"authorized"}, "capturing", "provider shows captured (recovery)",
                                 {"amount": a["captured"]})
                await finalize_capture(s, updated, a["captured"], merchant, {"capturing"}, "captured (found by recovery)")
