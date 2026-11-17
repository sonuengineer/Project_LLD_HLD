from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from bpcommon.errors import AppError, Forbidden, Unauthorized, Unprocessable

from ..services import idempotency, ledger, reconcile, recovery, saga, webhooks
from ..services import payments as pay

router = APIRouter()


async def merchant(request: Request, authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer sk_test_"):
        raise Unauthorized("merchant API key required (sk_test_...)")
    h = hashlib.sha256(authorization[7:].encode()).hexdigest()
    async with request.app.state.sm() as s:
        row = (await s.execute(text("SELECT id, name, fee_bps, fee_fixed FROM merchants WHERE api_key_hash = :h"),
                               {"h": h})).mappings().first()
    if row is None:
        raise Unauthorized("invalid API key")
    return dict(row)


async def admin(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    if not x_admin_token or not hmac.compare_digest(x_admin_token, request.app.state.settings.admin_token):
        raise Forbidden("admin token required")


async def idempotent(request: Request, m: dict, key: str | None, handler, status: int = 200) -> JSONResponse:
    """Run `handler` at most once per (merchant, Idempotency-Key)."""
    if not key or len(key) > 255:
        raise Unprocessable("Idempotency-Key header is required for this endpoint (max 255 chars)")
    st, sm = request.app.state.settings, request.app.state.sm
    body = await request.body()
    replay = await idempotency.begin(sm, m["id"], key, request.method, request.url.path, body, st.idempotency_lock_seconds)
    if replay is not None:
        code, payload = replay
        return JSONResponse(payload, status_code=code, headers={"Idempotent-Replayed": "true"})
    try:
        result = await handler()
    except AppError as exc:
        if exc.status_code < 500 and exc.status_code != 409:
            payload = {"error": {"code": exc.code, "message": exc.message, "details": exc.details}}
            await idempotency.complete(sm, m["id"], key, exc.status_code, payload)   # deterministic: replay the same error
        else:
            await idempotency.abandon(sm, m["id"], key)
        raise
    except Exception:
        await idempotency.abandon(sm, m["id"], key)   # unknown failure: let the client retry with the same key
        raise
    payload = json.loads(json.dumps(result, default=str))
    await idempotency.complete(sm, m["id"], key, status, payload)
    return JSONResponse(payload, status_code=status)


# ---- admin -----------------------------------------------------------------------------------------
class MerchantIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    fee_bps: int = Field(default=290, ge=0, le=10_000)
    fee_fixed: int = Field(default=30, ge=0)


@router.post("/admin/merchants", status_code=201, tags=["admin"], dependencies=[Depends(admin)])
async def create_merchant(body: MerchantIn, request: Request):
    key = "sk_test_" + secrets.token_urlsafe(24)
    async with request.app.state.sm() as s, s.begin():
        mid = await s.scalar(text("INSERT INTO merchants (name, api_key_hash, fee_bps, fee_fixed) VALUES (:n, :h, :b, :f) RETURNING id"),
                             {"n": body.name, "h": hashlib.sha256(key.encode()).hexdigest(), "b": body.fee_bps, "f": body.fee_fixed})
    return {"merchant_id": mid, "api_key": key}


@router.post("/admin/recovery/run", tags=["admin"], dependencies=[Depends(admin)])
async def run_recovery(request: Request, stuck_after_seconds: float | None = None):
    st = request.app.state.settings
    return await recovery.run_recovery(request.app.state.sm, request.app.state.provider,
                                       st.stuck_after_seconds if stuck_after_seconds is None else stuck_after_seconds)


@router.post("/admin/reconciliation/runs", tags=["admin"], dependencies=[Depends(admin)])
async def reconcile_day(request: Request, day: date):
    return await reconcile.run(request.app.state.sm, request.app.state.provider, day)


@router.get("/admin/reconciliation/runs/{run_id}", tags=["admin"], dependencies=[Depends(admin)])
async def reconciliation_run(run_id: uuid.UUID, request: Request):
    async with request.app.state.sm() as s:
        run = (await s.execute(text("SELECT * FROM reconciliation_runs WHERE id = :i"), {"i": run_id})).mappings().first()
        items = (await s.execute(text("SELECT kind, payment_id, provider_payment_id, ours, theirs FROM reconciliation_items "
                                      "WHERE run_id = :i AND kind <> 'matched'"), {"i": run_id})).mappings().all()
    return {"run": dict(run) if run else None, "exceptions": [dict(i) for i in items]}


@router.get("/admin/ledger/trial-balance", tags=["admin"], dependencies=[Depends(admin)])
async def trial_balance(request: Request):
    async with request.app.state.sm() as s:
        return {"sum_of_all_entries": await ledger.trial_balance(s)}


@router.post("/admin/inventory", tags=["admin"], dependencies=[Depends(admin)])
async def set_inventory(request: Request, sku: str, available: int = Query(ge=0)):
    async with request.app.state.sm() as s, s.begin():
        await s.execute(text("INSERT INTO inventory (sku, available) VALUES (:s, :a) ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available"),
                        {"s": sku, "a": available})
    return {"sku": sku, "available": available}


# ---- payments ---------------------------------------------------------------------------------------
class PaymentIn(BaseModel):
    amount: int = Field(gt=0, le=10**12, description="minor units (e.g. paise)")
    currency: str = Field(pattern=r"^[A-Za-z]{3}$")
    payment_method: str = Field(pattern=r"^tok_[a-z_]+$")
    merchant_reference: str = Field(min_length=1, max_length=200)
    capture: bool = True
    description: str = Field(default="", max_length=500)


@router.post("/payments", tags=["payments"])
async def create_payment(body: PaymentIn, request: Request, m: dict = Depends(merchant),
                         idempotency_key: str | None = Header(default=None)):
    async def go():
        return await pay.create_payment(request.app.state.sm, request.app.state.provider, m, **body.model_dump(),
                                        payment_id=pay.id_for(m["id"], idempotency_key, "payment"))
    return await idempotent(request, m, idempotency_key, go, status=201)


class CaptureIn(BaseModel):
    amount: int | None = Field(default=None, gt=0)


@router.post("/payments/{payment_id}/capture", tags=["payments"])
async def capture(payment_id: uuid.UUID, body: CaptureIn, request: Request, m: dict = Depends(merchant),
                  idempotency_key: str | None = Header(default=None)):
    async def go():
        return await pay.capture_payment(request.app.state.sm, request.app.state.provider, m, payment_id, body.amount)
    return await idempotent(request, m, idempotency_key, go)


@router.post("/payments/{payment_id}/void", tags=["payments"])
async def void(payment_id: uuid.UUID, request: Request, m: dict = Depends(merchant),
               idempotency_key: str | None = Header(default=None)):
    async def go():
        return await pay.void_payment(request.app.state.sm, request.app.state.provider, m, payment_id)
    return await idempotent(request, m, idempotency_key, go)


class RefundIn(BaseModel):
    amount: int = Field(gt=0)
    reason: str = Field(default="", max_length=500)


@router.post("/payments/{payment_id}/refunds", tags=["payments"])
async def refund(payment_id: uuid.UUID, body: RefundIn, request: Request, m: dict = Depends(merchant),
                 idempotency_key: str | None = Header(default=None)):
    async def go():
        return await pay.create_refund(request.app.state.sm, request.app.state.provider, m, payment_id, body.amount, body.reason,
                                       refund_id=pay.id_for(m["id"], idempotency_key, "refund"))
    return await idempotent(request, m, idempotency_key, go, status=201)


@router.get("/payments/{payment_id}", tags=["payments"])
async def get_payment(payment_id: uuid.UUID, request: Request, m: dict = Depends(merchant)):
    async with request.app.state.sm() as s:
        p = await pay.get_payment(s, payment_id, m["id"])
        events = (await s.execute(text("SELECT from_status, to_status, reason, data, created_at FROM payment_events "
                                       "WHERE payment_id = :i ORDER BY id"), {"i": payment_id})).mappings().all()
        refunds = (await s.execute(text("SELECT id, amount, status, reason, created_at FROM refunds WHERE payment_id = :i "
                                        "ORDER BY created_at"), {"i": payment_id})).mappings().all()
    return {**p, "events": [dict(e) for e in events], "refunds": [dict(r) for r in refunds]}


@router.get("/payments", tags=["payments"])
async def list_payments(request: Request, m: dict = Depends(merchant), status: str | None = None,
                        limit: int = Query(50, ge=1, le=500)):
    q = "SELECT * FROM payments WHERE merchant_id = :m"
    params = {"m": m["id"], "l": limit}
    if status:
        q += " AND status = :s"
        params["s"] = status
    async with request.app.state.sm() as s:
        rows = (await s.execute(text(q + " ORDER BY created_at DESC LIMIT :l"), params)).mappings().all()
    return {"payments": [dict(r) for r in rows]}


@router.get("/ledger/balances", tags=["ledger"])
async def balances(request: Request, m: dict = Depends(merchant)):
    async with request.app.state.sm() as s:
        return {"balances": await ledger.balances(s, m["id"])}


class Item(BaseModel):
    sku: str
    qty: int = Field(gt=0)


class CheckoutIn(BaseModel):
    order_id: str = Field(min_length=1, max_length=100)
    items: list[Item] = Field(min_length=1)
    amount: int = Field(gt=0)
    currency: str = "INR"
    payment_method: str = Field(pattern=r"^tok_[a-z_]+$")
    simulate_shipping_failure: bool = False


@router.post("/checkout", tags=["saga"])
async def checkout(body: CheckoutIn, request: Request, m: dict = Depends(merchant)):
    return await saga.checkout(request.app.state.sm, request.app.state.provider, m, body.order_id,
                               [i.model_dump() for i in body.items], body.amount, body.currency, body.payment_method,
                               body.simulate_shipping_failure)


@router.post("/webhooks/provider", tags=["webhooks"])
async def provider_webhook(request: Request):
    body = await request.body()
    evt = webhooks.verify(request.app.state.settings.provider_webhook_secret, body, request.headers.get("x-provider-signature"))
    return {"outcome": await webhooks.handle(request.app.state.sm, evt)}
