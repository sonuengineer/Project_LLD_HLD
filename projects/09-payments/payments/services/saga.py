"""Checkout saga (orchestrated): reserve inventory -> charge payment -> create shipment.

There is no distributed transaction spanning inventory, the payment provider and the shipping service. A saga
runs local steps in order and, if one fails, runs COMPENSATIONS for the completed ones in reverse:
    shipment fails  -> refund the payment -> release the inventory
Each step's completion is persisted (saga_steps) so a crash can be resumed/compensated, and steps are
idempotent (unique reservation per order; payment idempotent by merchant_reference).
(Project 10 generalises this into a durable workflow engine.)

Two rules learned the hard way (review fixes):
  * A payment whose outcome is UNKNOWN (requires_reconciliation / still in flight) is NOT a failure. Compensating
    would release the stock and cancel the order while recovery may still capture the money -> customer charged,
    order cancelled. Such a saga stops in 'failed' with reason payment_outcome_unknown and keeps the reservation;
    an operator (or a later resume) decides once recovery has resolved the payment.
  * A compensation can itself fail (refund rejected / ambiguous). Then the saga is 'failed', not 'compensated'.
"""
from __future__ import annotations

import json

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from bpcommon.errors import Conflict, Unprocessable

from . import payments as pay


class ShippingFailed(Exception):
    pass


UNRESOLVED = {"authorizing", "capturing", "requires_reconciliation"}


async def _step(sm, saga_id, step: str, status: str, detail: dict) -> None:
    async with sm() as s, s.begin():
        await s.execute(text("INSERT INTO saga_steps (saga_id, step, status, detail) VALUES (:s, :st, :x, CAST(:d AS jsonb)) "
                             "ON CONFLICT (saga_id, step) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, at = now()"),
                        {"s": saga_id, "st": step, "x": status, "d": json.dumps(detail, default=str)})


async def _status(sm, saga_id, status: str, **ctx) -> None:
    async with sm() as s, s.begin():
        await s.execute(text("UPDATE sagas SET status = :st, context = context || CAST(:c AS jsonb), updated_at = now() WHERE id = :i"),
                        {"st": status, "c": json.dumps(ctx, default=str), "i": saga_id})


async def checkout(sm, provider, merchant: dict, order_id: str, items: list[dict], amount: int, currency: str,
                   payment_method: str, shipping_should_fail: bool = False) -> dict:
    try:
        async with sm() as s, s.begin():
            saga_id = await s.scalar(text("INSERT INTO sagas (kind, order_id, status) VALUES ('checkout', :o, 'running') RETURNING id"),
                                     {"o": order_id})
    except IntegrityError:
        raise Conflict("checkout for this order already exists") from None
    done: list[str] = []
    payment = None
    try:
        # step 1: reserve inventory (local transaction, all-or-nothing across skus)
        async with sm() as s, s.begin():
            for it in items:
                ok = await s.scalar(text("UPDATE inventory SET available = available - :q WHERE sku = :s AND available >= :q RETURNING sku"),
                                    {"q": it["qty"], "s": it["sku"]})
                if not ok:
                    raise Unprocessable(f"insufficient stock for {it['sku']}")
                await s.execute(text("INSERT INTO reservations (order_id, sku, qty, status) VALUES (:o, :s, :q, 'held')"),
                                {"o": order_id, "s": it["sku"], "q": it["qty"]})
        await _step(sm, saga_id, "reserve_inventory", "done", {"items": items})
        done.append("reserve_inventory")
        # step 2: charge (authorize + capture)
        payment = await pay.create_payment(sm, provider, merchant, amount=amount, currency=currency,
                                           payment_method=payment_method, merchant_reference=order_id, capture=True)
        if payment["status"] in UNRESOLVED:
            await _step(sm, saga_id, "charge_payment", "failed", {"payment_id": payment["id"], "status": payment["status"]})
            await _status(sm, saga_id, "failed", reason="payment_outcome_unknown", payment_id=str(payment["id"]))
            return {"saga_id": saga_id, "status": "failed", "reason": "payment_outcome_unknown",
                    "payment_id": payment["id"]}
        if payment["status"] != "captured":
            raise Unprocessable(f"payment {payment['status']}", details={"payment_id": str(payment["id"])})
        await _step(sm, saga_id, "charge_payment", "done", {"payment_id": payment["id"]})
        done.append("charge_payment")
        # step 3: create shipment (external service; simulated)
        if shipping_should_fail:
            raise ShippingFailed("carrier API rejected the address")
        await _step(sm, saga_id, "create_shipment", "done", {"tracking": f"TRK-{order_id}"})
        async with sm() as s, s.begin():
            await s.execute(text("UPDATE reservations SET status = 'consumed' WHERE order_id = :o"), {"o": order_id})
        await _status(sm, saga_id, "completed", payment_id=str(payment["id"]))
        return {"saga_id": saga_id, "status": "completed", "payment_id": payment["id"]}
    except Exception as exc:
        await _status(sm, saga_id, "compensating", error=str(exc))
        ok = await compensate(sm, provider, merchant, saga_id, order_id, done, payment)
        final = "compensated" if ok else "failed"
        await _status(sm, saga_id, final, **({} if ok else {"reason": "compensation_incomplete"}))
        return {"saga_id": saga_id, "status": final, "error": str(exc),
                "payment_id": payment["id"] if payment else None}


async def compensate(sm, provider, merchant, saga_id, order_id: str, done: list[str], payment) -> bool:
    """Returns False if a compensation did not certainly succeed (the saga must not claim 'compensated')."""
    ok = True
    for step in reversed(done):
        if step == "charge_payment" and payment is not None:
            try:
                r = await pay.create_refund(sm, provider, merchant, payment["id"], payment["amount_captured"],
                                            "saga compensation", refund_id=pay.id_for(merchant["id"], f"saga:{saga_id}", "refund"))
                status = r["status"]
            except Exception as exc:                  # noqa: BLE001 -- recorded, saga marked failed
                status = f"error: {exc}"
            if status == "succeeded":
                await _step(sm, saga_id, "charge_payment", "compensated", {"refunded": payment["amount_captured"]})
            else:
                ok = False
                await _step(sm, saga_id, "charge_payment", "failed", {"refund_status": status})
        elif step == "reserve_inventory":
            async with sm() as s, s.begin():
                rows = (await s.execute(text("UPDATE reservations SET status = 'released' WHERE order_id = :o AND status = 'held' "
                                             "RETURNING sku, qty"), {"o": order_id})).all()
                for sku, qty in rows:
                    await s.execute(text("UPDATE inventory SET available = available + :q WHERE sku = :s"), {"q": qty, "s": sku})
            await _step(sm, saga_id, "reserve_inventory", "compensated", {"released": len(rows)})
    return ok
