"""The five example workflows. Plain async Python; only ctx.* may be awaited (deterministic replay)."""
from __future__ import annotations

import asyncio

from ..runtime import ActivityError, RetryPolicy, WorkflowCancelled, workflow

FAST = RetryPolicy(initial_interval=0.05, maximum_interval=0.5, maximum_attempts=3)


@workflow("order_processing")
async def order_processing(ctx, inp):
    """Reserve -> charge -> ship -> confirm, with compensations (saga) on failure."""
    res = await ctx.execute_activity("reserve_inventory", inp["items"], retry=FAST)
    try:
        charge = await ctx.execute_activity("charge_payment", inp["amount"], inp.get("card", "ok"), retry=FAST)
    except ActivityError as e:
        await ctx.execute_activity("release_inventory", res["reservation_id"], retry=FAST)
        return {"status": "payment_failed", "reason": e.message}
    try:
        ship = await ctx.execute_activity("ship_order", inp["order_id"], inp.get("fail_shipping", False), retry=FAST)
    except ActivityError as e:
        await ctx.execute_activity("refund_payment", charge["charge_id"], inp["amount"], retry=FAST)
        await ctx.execute_activity("release_inventory", res["reservation_id"], retry=FAST)
        return {"status": "compensated", "reason": e.message}
    await ctx.execute_activity("send_email", inp["customer"], "order_confirmed", retry=FAST)
    return {"status": "completed", "tracking": ship["tracking"], "charge_id": charge["charge_id"]}


@workflow("payment_and_refund")
async def payment_and_refund(ctx, inp):
    """Charge now; refund automatically if delivery isn't confirmed within the window."""
    charge = await ctx.execute_activity("charge_payment", inp["amount"], inp.get("card", "ok"), retry=FAST)
    delivered = await ctx.wait_signal("delivered", timeout=inp["delivery_timeout"])
    if delivered:
        return {"status": "paid", "delivered_at": delivered.get("at")}
    await ctx.execute_activity("refund_payment", charge["charge_id"], inp["amount"], retry=FAST)
    return {"status": "refunded_not_delivered"}


@workflow("customer_onboarding")
async def customer_onboarding(ctx, inp):
    acct = await ctx.execute_activity("create_account", inp["email"], retry=FAST)
    await ctx.execute_activity("send_email", inp["email"], "welcome", retry=FAST)
    verified = await ctx.wait_signal("verified", timeout=inp["verify_within"])
    if not verified:
        await ctx.execute_activity("send_email", inp["email"], "verify_reminder", retry=FAST)
    await ctx.sleep(inp["tips_after"])                       # durable timer: days in real life
    await ctx.execute_activity("send_email", inp["email"], "tips", retry=FAST)
    return {"account_id": acct["account_id"], "verified_in_time": bool(verified)}


@workflow("document_approval")
async def document_approval(ctx, inp):
    try:
        await ctx.execute_activity("notify", inp["approvers"], f"please review {inp['doc_id']}", retry=FAST)
        decision = await ctx.wait_signal("decision", timeout=inp["escalate_after"])
        if decision is None:
            await ctx.execute_activity("notify", inp["escalation_to"], f"{inp['doc_id']} waiting for approval", retry=FAST)
            decision = await ctx.wait_signal("decision")
        if decision["approved"]:
            await ctx.execute_activity("archive_document", inp["doc_id"], retry=FAST)
            return {"status": "approved", "by": decision.get("by")}
        return {"status": "rejected", "by": decision.get("by"), "comment": decision.get("comment")}
    except WorkflowCancelled:
        await ctx.execute_activity("notify", inp["approvers"], f"review of {inp['doc_id']} cancelled", retry=FAST)
        raise


@workflow("email_campaign")
async def email_campaign(ctx, inp):
    """Batches of parallel sends with a pause between batches; bounced addresses don't fail the campaign."""
    recipients, size = inp["recipients"], inp["batch_size"]
    sent, failed = 0, []
    for i in range(0, len(recipients), size):
        batch = recipients[i:i + size]
        results = await asyncio.gather(*[ctx.execute_activity("send_email", r, inp["template"], retry=FAST) for r in batch],
                                       return_exceptions=True)
        for r, out in zip(batch, results):
            if isinstance(out, ActivityError):
                failed.append(r)
            else:
                sent += 1
        if i + size < len(recipients):
            await ctx.sleep(inp["pause"])
    return {"sent": sent, "failed": failed, "batches": (len(recipients) + size - 1) // size}
