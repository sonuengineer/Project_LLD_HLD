"""Payment flows. Pattern for every provider interaction:

  1. short DB transaction: validate + move to an INTERMEDIATE state (authorizing / capturing / voiding / refund pending)
  2. call the provider OUTSIDE any transaction (never hold row locks across a network call)
     with a deterministic idempotency key derived from our ids
  3. short DB transaction: compare-and-set from the intermediate state to the outcome, book the ledger in the
     SAME transaction as the status change
If step 2 is ambiguous (timeout / 5xx after retries) -> requires_reconciliation; recovery resolves it later.
If the process dies between 1 and 3 -> the intermediate state is "stuck"; recovery resolves it too.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from bpcommon.errors import AppError, Conflict, NotFound, Unprocessable

from . import ledger
from .money import SUPPORTED_CURRENCIES, fee_for
from .provider import ProviderRejected, ProviderTimeout, ProviderUnavailable
from .state import transition

log = logging.getLogger(__name__)
AMBIGUOUS = (ProviderTimeout, ProviderUnavailable)


class DuplicatePayment(AppError):
    status_code, code = 409, "duplicate_payment"


async def get_payment(s, payment_id, merchant_id=None) -> dict:
    q = "SELECT * FROM payments WHERE id = :i"
    params = {"i": payment_id}
    if merchant_id is not None:
        q += " AND merchant_id = :m"
        params["m"] = merchant_id
    row = (await s.execute(text(q), params)).mappings().first()
    if row is None:
        raise NotFound("payment not found")
    return dict(row)


def id_for(merchant_id, idempotency_key: str | None, kind: str) -> uuid.UUID:
    """Deterministic id for the object an idempotent request creates. If the first attempt crashed after
    inserting it, the retry that takes over the idempotency lock gets the SAME id, finds the row and resumes it
    -- with the same provider idempotency key (auth-{id}, refund-{id}), so the provider dedupes too.
    A random id per attempt would create a second object and a second provider call."""
    if idempotency_key is None:
        return uuid.uuid4()
    return uuid.uuid5(uuid.NAMESPACE_URL, f"bp-payments:{kind}:{merchant_id}:{idempotency_key}")


async def create_payment(sm, provider, merchant: dict, *, amount: int, currency: str, payment_method: str,
                         merchant_reference: str, capture: bool, description: str = "",
                         payment_id: uuid.UUID | None = None) -> dict:
    currency = currency.upper()
    if currency not in SUPPORTED_CURRENCIES:
        raise Unprocessable(f"unsupported currency {currency}")
    pid = payment_id or uuid.uuid4()
    async with sm() as s:
        existing = (await s.execute(text("SELECT * FROM payments WHERE id = :i AND merchant_id = :m"),
                                    {"i": pid, "m": merchant["id"]})).mappings().first()
    if existing is not None:
        # Takeover after a crashed attempt. Only 'authorizing' is resumable here (re-sending auth-{pid} is
        # deduplicated by the provider); any other state is already decided or owned by recovery.
        if existing["status"] != "authorizing":
            return dict(existing)
        return await _authorize(sm, provider, merchant, pid, amount, currency, payment_method, capture)
    try:
        async with sm() as s, s.begin():
            await s.execute(text(
                "INSERT INTO payments (id, merchant_id, merchant_reference, amount, currency, status, payment_method, provider, description) "
                "VALUES (:i, :m, :r, :a, :c, 'created', :pm, :pr, :d)"),
                {"i": pid, "m": merchant["id"], "r": merchant_reference, "a": amount, "c": currency, "pm": payment_method,
                 "pr": provider.name, "d": description})
            await transition(s, pid, {"created"}, "authorizing", "authorization requested")
    except IntegrityError:
        async with sm() as s:
            live = await s.scalar(text("SELECT id FROM payments WHERE merchant_id = :m AND merchant_reference = :r "
                                       "AND status NOT IN ('declined', 'failed', 'voided')"),
                                  {"m": merchant["id"], "r": merchant_reference})
        raise DuplicatePayment("a live payment already exists for this merchant_reference (would be a double charge)",
                               details={"payment_id": str(live)}) from None
    return await _authorize(sm, provider, merchant, pid, amount, currency, payment_method, capture)


async def _authorize(sm, provider, merchant: dict, pid, amount: int, currency: str, payment_method: str,
                     capture: bool) -> dict:
    try:
        res = await provider.authorize(amount, currency, payment_method, str(pid), idem=f"auth-{pid}")
    except AMBIGUOUS as exc:
        async with sm() as s, s.begin():
            return await transition(s, pid, {"authorizing"}, "requires_reconciliation", "authorization outcome unknown",
                                    {"error": str(exc)}, last_error=str(exc))
    except ProviderRejected as exc:
        async with sm() as s, s.begin():
            return await transition(s, pid, {"authorizing"}, "failed", "provider rejected request", {"error": str(exc)},
                                    last_error=str(exc))
    async with sm() as s, s.begin():
        if res["status"] == "declined":
            payment = await transition(s, pid, {"authorizing"}, "declined", "issuer declined",
                                       {"decline_code": res.get("decline_code")}, decline_code=res.get("decline_code"),
                                       provider_payment_id=res["id"])
            return payment
        payment = await transition(s, pid, {"authorizing"}, "authorized", "issuer approved", {"provider_id": res["id"]},
                                   amount_authorized=res["amount"], provider_payment_id=res["id"])
    if capture:
        payment = await capture_payment(sm, provider, merchant, pid, None)
    return payment


async def finalize_capture(s, payment: dict, amount: int, merchant: dict, expected: set[str], reason: str) -> dict:
    fee = fee_for(amount, merchant["fee_bps"], merchant["fee_fixed"])
    updated = await transition(s, payment["id"], expected, "captured", reason, {"amount": amount, "fee": fee},
                               amount_captured=amount, fee=fee)
    await ledger.book_capture(s, updated, amount, fee)    # same transaction: status and books can't disagree
    return updated


async def capture_payment(sm, provider, merchant: dict, payment_id, amount: int | None) -> dict:
    async with sm() as s, s.begin():
        p = await get_payment(s, payment_id, merchant["id"])
        amount = amount or p["amount_authorized"]
        if p["status"] == "authorized" and not 0 < amount <= p["amount_authorized"]:
            raise Unprocessable("capture amount must be within the authorized amount")
        p = await transition(s, payment_id, {"authorized"}, "capturing", "capture requested", {"amount": amount})
    try:
        await provider.capture(p["provider_payment_id"], amount, idem=f"capture-{payment_id}")
    except AMBIGUOUS as exc:
        async with sm() as s, s.begin():
            return await transition(s, payment_id, {"capturing"}, "requires_reconciliation", "capture outcome unknown",
                                    {"amount": amount, "error": str(exc)}, last_error=str(exc))
    except ProviderRejected as exc:
        async with sm() as s, s.begin():
            return await transition(s, payment_id, {"capturing"}, "authorized", "capture rejected", {"error": str(exc)},
                                    last_error=str(exc))
    async with sm() as s, s.begin():
        # A provider webhook may already have finalised it (expected includes 'captured' via the no-op path below).
        current = await get_payment(s, payment_id)
        if current["status"] == "captured":
            return current
        return await finalize_capture(s, current, amount, merchant, {"capturing", "requires_reconciliation"}, "capture confirmed")


async def void_payment(sm, provider, merchant: dict, payment_id) -> dict:
    async with sm() as s, s.begin():
        p = await get_payment(s, payment_id, merchant["id"])
        await transition(s, payment_id, {"authorized"}, "voiding", "void requested")
    try:
        await provider.void(p["provider_payment_id"], idem=f"void-{payment_id}")
    except AMBIGUOUS as exc:
        async with sm() as s, s.begin():
            return await transition(s, payment_id, {"voiding"}, "requires_reconciliation", "void outcome unknown",
                                    {"error": str(exc)}, last_error=str(exc))
    except ProviderRejected as exc:
        async with sm() as s, s.begin():
            return await transition(s, payment_id, {"voiding"}, "authorized", "void rejected", {"error": str(exc)})
    async with sm() as s, s.begin():
        return await transition(s, payment_id, {"voiding"}, "voided", "void confirmed")


async def create_refund(sm, provider, merchant: dict, payment_id, amount: int, reason: str = "",
                        refund_id: uuid.UUID | None = None) -> dict:
    if refund_id is not None:
        async with sm() as s:
            prev = (await s.execute(text("SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id "
                                         "WHERE r.id = :r AND p.merchant_id = :m"),
                                    {"r": refund_id, "m": merchant["id"]})).mappings().first()
        if prev is not None:
            # Takeover after a crash: never insert a second refund. Resume a pending one with the SAME
            # provider key (refund-{id}); anything else is final or owned by recovery.
            if prev["status"] != "pending":
                return {"id": prev["id"], "status": prev["status"], "amount": prev["amount"]}
            async with sm() as s:
                p = await get_payment(s, prev["payment_id"])
            return await _send_refund(sm, provider, p, refund_id, prev["amount"])
    async with sm() as s, s.begin():
        p = (await s.execute(text("SELECT * FROM payments WHERE id = :i AND merchant_id = :m FOR UPDATE"),
                             {"i": payment_id, "m": merchant["id"]})).mappings().first()
        if p is None:
            raise NotFound("payment not found")
        if p["status"] not in ("captured", "partially_refunded"):
            raise Conflict(f"cannot refund a payment in status {p['status']}")
        # Count PENDING refunds too, or two concurrent refunds could each pass the check (over-refund race).
        pending = await s.scalar(text("SELECT coalesce(sum(amount), 0) FROM refunds WHERE payment_id = :i "
                                      "AND status IN ('pending', 'requires_reconciliation')"), {"i": payment_id})
        if p["amount_refunded"] + int(pending) + amount > p["amount_captured"]:
            raise Unprocessable("refund exceeds the refundable amount",
                                details={"captured": p["amount_captured"], "refunded": p["amount_refunded"],
                                         "pending": int(pending)})
        rid = await s.scalar(text("INSERT INTO refunds (id, payment_id, amount, status, reason) "
                                  "VALUES (:i, :p, :a, 'pending', :r) RETURNING id"),
                             {"i": refund_id or uuid.uuid4(), "p": payment_id, "a": amount, "r": reason})
    return await _send_refund(sm, provider, p, rid, amount)


async def _send_refund(sm, provider, p: dict, rid, amount: int) -> dict:
    try:
        res = await provider.refund(p["provider_payment_id"], amount, str(rid), idem=f"refund-{rid}")
    except AMBIGUOUS as exc:
        async with sm() as s, s.begin():
            await s.execute(text("UPDATE refunds SET status = 'requires_reconciliation', updated_at = now() WHERE id = :r AND status = 'pending'"),
                            {"r": rid})
        return {"id": rid, "status": "requires_reconciliation", "amount": amount}
    except ProviderRejected:
        async with sm() as s, s.begin():
            await s.execute(text("UPDATE refunds SET status = 'failed', updated_at = now() WHERE id = :r"), {"r": rid})
        return {"id": rid, "status": "failed", "amount": amount}
    return await finalize_refund(sm, rid, res["id"])


async def finalize_refund(sm, refund_id, provider_refund_id: str) -> dict:
    """Idempotent: from the API response, from a webhook, or from recovery -- whichever arrives first wins."""
    async with sm() as s, s.begin():
        r = (await s.execute(text("SELECT * FROM refunds WHERE id = :i FOR UPDATE"), {"i": refund_id})).mappings().first()
        if r is None:
            raise NotFound("refund not found")
        if r["status"] == "succeeded":
            return dict(r)
        p = (await s.execute(text("SELECT * FROM payments WHERE id = :i FOR UPDATE"), {"i": r["payment_id"]})).mappings().one()
        new_total = p["amount_refunded"] + r["amount"]
        to = "refunded" if new_total == p["amount_captured"] else "partially_refunded"
        p = await transition(s, p["id"], {"captured", "partially_refunded"}, to, "refund succeeded",
                             {"refund_id": str(refund_id), "amount": r["amount"]}, amount_refunded=new_total)
        await ledger.book_refund(s, p, refund_id, r["amount"])
        row = (await s.execute(text("UPDATE refunds SET status = 'succeeded', provider_refund_id = :pr, updated_at = now() "
                                    "WHERE id = :i RETURNING *"), {"pr": provider_refund_id, "i": refund_id})).mappings().one()
        return dict(row)
