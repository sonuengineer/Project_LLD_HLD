"""Mock payment provider (stands in for Stripe/Razorpay/Adyen). A SEPARATE service with its own schema,
reached only over HTTP -- so timeouts, retries and ambiguous outcomes are real. Never real money.

Test card tokens:
    tok_visa                 authorize ok
    tok_declined             declined (card_declined)
    tok_insufficient_funds   declined (insufficient_funds)
    tok_slow                 authorization IS recorded, but the response takes SLOW_SECONDS (client times out:
                             the classic "did my payment go through?" ambiguity)
    tok_flaky                first call for an idempotency key fails with 500 and records nothing; retries succeed
    tok_capture_fails        authorize ok, capture rejected (402)
Every mutating call takes an Idempotency-Key: a repeated key returns the original result.
Captures and refunds emit signed webhooks to PROVIDER_WEBHOOK_URL (asynchronously, like real providers).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import date

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class AuthIn(BaseModel):
    amount: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    token: str
    reference: str


class AmountIn(BaseModel):
    amount: int | None = Field(default=None, gt=0)


class RefundIn(BaseModel):
    authorization_id: str
    amount: int = Field(gt=0)
    reference: str = ""       # merchant's refund id, echoed back (webhooks can beat the HTTP response)


def create_provider_app(database_url: str | None = None, *, api_key: str | None = None, webhook_url: str | None = None,
                        webhook_secret: str | None = None, slow_seconds: float = 2.0,
                        webhook_transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    database_url = database_url or os.getenv("PROVIDER_DATABASE_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p09_payments")
    api_key = api_key or os.getenv("PROVIDER_API_KEY", "mock_provider_key")
    webhook_url = webhook_url or os.getenv("PROVIDER_WEBHOOK_URL")
    webhook_secret = webhook_secret or os.getenv("PROVIDER_WEBHOOK_SECRET", "whsec_mock_provider")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = create_async_engine(database_url, pool_size=5)
        app.state.sm = async_sessionmaker(engine, expire_on_commit=False)
        app.state.hook = httpx.AsyncClient(transport=webhook_transport, timeout=5)
        app.state.tasks = set()
        yield
        if app.state.tasks:
            await asyncio.gather(*app.state.tasks, return_exceptions=True)
        await app.state.hook.aclose()
        await engine.dispose()

    app = FastAPI(title="Mock Payment Provider", lifespan=lifespan)
    app.state.webhook_url = webhook_url
    app.state.events_sent = []

    def check_key(authorization: str | None):
        if authorization != f"Bearer {api_key}":
            raise HTTPException(401, "bad provider api key")

    def view(row) -> dict:
        return {"id": row.id, "reference": row.reference, "amount": row.amount, "currency": row.currency,
                "captured": row.captured, "refunded": row.refunded, "status": row.status}

    async def emit(event_type: str, data: dict) -> None:
        """Signed webhook, delivered asynchronously (fire and forget, may arrive before/after our API response)."""
        if not app.state.webhook_url:
            return
        body = json.dumps({"id": "pevt_" + secrets.token_hex(8), "type": event_type, "created": int(time.time()),
                           "data": data}).encode()
        ts = str(int(time.time()))
        sig = hmac.new(webhook_secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()

        async def send():
            try:
                await app.state.hook.post(app.state.webhook_url, content=body,
                                          headers={"content-type": "application/json", "x-provider-signature": f"t={ts},v1={sig}"})
                app.state.events_sent.append(json.loads(body))
            except httpx.HTTPError:
                pass   # a real provider retries for days; the merchant must also reconcile
        t = asyncio.create_task(send())
        app.state.tasks.add(t)
        t.add_done_callback(app.state.tasks.discard)

    async def replay(s, key: str) -> dict | None:
        return await s.scalar(text("SELECT response FROM provider.operations WHERE idempotency_key = :k"), {"k": key})

    @app.post("/v1/authorizations")
    async def authorize(body: AuthIn, request: Request, authorization: str | None = Header(default=None),
                        idempotency_key: str = Header(...)):
        check_key(authorization)
        if body.token == "tok_flaky":
            # Commit the "seen" marker in its OWN transaction before failing; raising inside the main
            # transaction rolled the marker back so every retry failed too.
            async with app.state.sm() as s, s.begin():
                first = await s.scalar(text("INSERT INTO provider.flaky (token_ref) VALUES (:k) ON CONFLICT DO NOTHING "
                                            "RETURNING token_ref"), {"k": idempotency_key})
            if first:
                raise HTTPException(500, "temporary provider error")
        async with app.state.sm() as s, s.begin():
            existing = (await s.execute(text("SELECT * FROM provider.authorizations WHERE idempotency_key = :k"),
                                        {"k": idempotency_key})).first()
            if existing:
                return view(existing)
            status = {"tok_declined": "declined", "tok_insufficient_funds": "declined"}.get(body.token, "authorized")
            pid = "pa_" + secrets.token_hex(10)
            row = (await s.execute(text(
                "INSERT INTO provider.authorizations (id, reference, idempotency_key, amount, currency, status, token) "
                "VALUES (:i, :r, :k, :a, :c, :s, :t) RETURNING *"),
                {"i": pid, "r": body.reference, "k": idempotency_key, "a": body.amount, "c": body.currency.upper(),
                 "s": status, "t": body.token})).first()
        if body.token == "tok_slow":
            await asyncio.sleep(slow_seconds)        # committed already: the client will time out but it DID happen
        out = view(row)
        if status == "declined":
            out["decline_code"] = "insufficient_funds" if body.token == "tok_insufficient_funds" else "card_declined"
        return out

    @app.get("/v1/authorizations")
    async def find(reference: str, authorization: str | None = Header(default=None)):
        check_key(authorization)
        async with app.state.sm() as s:
            rows = (await s.execute(text("SELECT * FROM provider.authorizations WHERE reference = :r ORDER BY created_at"),
                                    {"r": reference})).all()
        return {"data": [view(r) for r in rows]}

    @app.get("/v1/authorizations/{pid}")
    async def get(pid: str, authorization: str | None = Header(default=None)):
        check_key(authorization)
        async with app.state.sm() as s:
            row = (await s.execute(text("SELECT * FROM provider.authorizations WHERE id = :i"), {"i": pid})).first()
        if row is None:
            raise HTTPException(404, "no such authorization")
        return view(row)

    @app.post("/v1/authorizations/{pid}/capture")
    async def capture(pid: str, body: AmountIn, authorization: str | None = Header(default=None),
                      idempotency_key: str = Header(...)):
        check_key(authorization)
        async with app.state.sm() as s, s.begin():
            if (r := await replay(s, idempotency_key)) is not None:
                return r
            row = (await s.execute(text("SELECT * FROM provider.authorizations WHERE id = :i FOR UPDATE"), {"i": pid})).first()
            if row is None:
                raise HTTPException(404, "no such authorization")
            if row.token == "tok_capture_fails":
                raise HTTPException(402, "capture declined by issuer")
            if row.status != "authorized":
                raise HTTPException(409, f"cannot capture in status {row.status}")
            amount = body.amount or row.amount
            if amount > row.amount:
                raise HTTPException(422, "capture exceeds authorization")
            row = (await s.execute(text("UPDATE provider.authorizations SET captured = :a, status = 'captured', "
                                        "updated_at = now() WHERE id = :i RETURNING *"), {"a": amount, "i": pid})).first()
            resp = view(row)
            await s.execute(text("INSERT INTO provider.operations (idempotency_key, response) VALUES (:k, CAST(:r AS jsonb))"),
                            {"k": idempotency_key, "r": json.dumps(resp)})
        await emit("authorization.captured", resp)
        return resp

    @app.post("/v1/authorizations/{pid}/void")
    async def void(pid: str, authorization: str | None = Header(default=None), idempotency_key: str = Header(...)):
        check_key(authorization)
        async with app.state.sm() as s, s.begin():
            if (r := await replay(s, idempotency_key)) is not None:
                return r
            row = (await s.execute(text("UPDATE provider.authorizations SET status = 'voided', updated_at = now() "
                                        "WHERE id = :i AND status = 'authorized' RETURNING *"), {"i": pid})).first()
            if row is None:
                raise HTTPException(409, "not voidable")
            resp = view(row)
            await s.execute(text("INSERT INTO provider.operations (idempotency_key, response) VALUES (:k, CAST(:r AS jsonb))"),
                            {"k": idempotency_key, "r": json.dumps(resp)})
        return resp

    @app.post("/v1/refunds")
    async def refund(body: RefundIn, authorization: str | None = Header(default=None), idempotency_key: str = Header(...)):
        check_key(authorization)
        async with app.state.sm() as s, s.begin():
            if (r := await replay(s, idempotency_key)) is not None:
                return r
            row = (await s.execute(text("SELECT * FROM provider.authorizations WHERE id = :i FOR UPDATE"),
                                   {"i": body.authorization_id})).first()
            if row is None or row.status not in ("captured",):
                raise HTTPException(409, "not refundable")
            if row.refunded + body.amount > row.captured:
                raise HTTPException(422, "refund exceeds captured amount")
            await s.execute(text("UPDATE provider.authorizations SET refunded = refunded + :a, updated_at = now() WHERE id = :i"),
                            {"a": body.amount, "i": body.authorization_id})
            resp = {"id": "pr_" + secrets.token_hex(8), "authorization_id": body.authorization_id, "amount": body.amount,
                    "reference": body.reference, "status": "succeeded"}
            await s.execute(text("INSERT INTO provider.operations (idempotency_key, response) VALUES (:k, CAST(:r AS jsonb))"),
                            {"k": idempotency_key, "r": json.dumps(resp)})
        await emit("refund.succeeded", resp)
        return resp

    @app.get("/v1/settlements")
    async def settlements(day: date, authorization: str | None = Header(default=None)):
        """Daily settlement report (what the provider will actually pay out) -- input to reconciliation."""
        check_key(authorization)
        async with app.state.sm() as s:
            rows = (await s.execute(text("SELECT * FROM provider.authorizations WHERE created_at::date = :d ORDER BY created_at"),
                                    {"d": day})).all()
        return {"date": str(day), "transactions": [view(r) for r in rows]}

    # test hook: simulate provider-side state drift (e.g. a chargeback/manual adjustment we never heard about)
    @app.post("/test/drift/{pid}")
    async def drift(pid: str, body: AmountIn):
        async with app.state.sm() as s, s.begin():
            await s.execute(text("UPDATE provider.authorizations SET captured = :a WHERE id = :i"), {"a": body.amount, "i": pid})
        return {"ok": True}

    return app


def app_from_env() -> FastAPI:
    return create_provider_app()
