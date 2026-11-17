"""Demo activities. Each records its side effect in activity_effects keyed by ctx.idempotency_key, so a retried
or redelivered activity can't perform its effect twice (INSERT ... ON CONFLICT DO NOTHING)."""
from __future__ import annotations

import asyncio
import json

from sqlalchemy import text

from ..activities import ActivityContext, NonRetryableError, activity


async def effect(ctx: ActivityContext, kind: str, payload: dict) -> bool:
    async with ctx.sm() as s, s.begin():
        row = await s.scalar(text("INSERT INTO activity_effects (idempotency_key, kind, payload) VALUES (:k, :t, CAST(:p AS jsonb)) "
                                  "ON CONFLICT DO NOTHING RETURNING idempotency_key"),
                             {"k": ctx.idempotency_key, "t": kind, "p": json.dumps(payload)})
    return row is not None


@activity("reserve_inventory")
async def reserve_inventory(ctx, items):
    await effect(ctx, "reserve", {"items": items})
    return {"reservation_id": ctx.idempotency_key}


@activity("release_inventory")
async def release_inventory(ctx, reservation_id):
    await effect(ctx, "release", {"reservation_id": reservation_id})
    return True


@activity("charge_payment")
async def charge_payment(ctx, amount, card):
    if card == "declined":
        raise NonRetryableError("card declined")          # retrying won't help
    if card == "flaky" and ctx.attempt < 3:
        raise ConnectionError(f"gateway timeout (attempt {ctx.attempt})")
    await effect(ctx, "charge", {"amount": amount})
    return {"charge_id": ctx.idempotency_key, "amount": amount}


@activity("refund_payment")
async def refund_payment(ctx, charge_id, amount):
    await effect(ctx, "refund", {"charge_id": charge_id, "amount": amount})
    return {"refunded": amount}


@activity("ship_order")
async def ship_order(ctx, order_id, fail):
    if fail:
        raise RuntimeError("carrier rejected the shipment")
    await effect(ctx, "ship", {"order_id": order_id})
    return {"tracking": f"TRK-{order_id}"}


@activity("send_email")
async def send_email(ctx, to, template):
    if "bounce" in to:
        raise NonRetryableError(f"mailbox {to} does not exist")
    await effect(ctx, "email", {"to": to, "template": template})
    return {"to": to, "template": template}


@activity("create_account")
async def create_account(ctx, email):
    await effect(ctx, "account", {"email": email})
    return {"account_id": ctx.idempotency_key, "email": email}


@activity("notify")
async def notify(ctx, who, message):
    await effect(ctx, "notify", {"who": who, "message": message})
    return True


@activity("archive_document")
async def archive_document(ctx, doc_id):
    await effect(ctx, "archive", {"doc_id": doc_id})
    return {"archived": doc_id}


@activity("long_task")
async def long_task(ctx, chunks, chunk_seconds):
    """Long-running activity: heartbeats after each chunk so its lease keeps extending; if the worker dies, the
    missed heartbeats let the lease expire quickly and another worker retries."""
    for i in range(chunks):
        await asyncio.sleep(chunk_seconds)
        if not await ctx.heartbeat({"done": i + 1}):
            return None                                     # we lost the task (fenced)
    await effect(ctx, "long_task", {"chunks": chunks})
    return {"chunks": chunks}
