import contextlib
import os

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from mockprovider.app import create_provider_app
from payments.config import Settings
from payments.main import create_app
from payments.services.provider import HttpProvider

DB_URL = os.getenv("PAY_TEST_DATABASE_URL", "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p09_payments_test")
TABLES = ("saga_steps, sagas, reservations, inventory, reconciliation_items, reconciliation_runs, provider_events, "
          "ledger_entries, ledger_transactions, ledger_accounts, idempotency_keys, refunds, payment_events, payments, merchants, "
          "provider.authorizations, provider.operations, provider.flaky")
ADMIN = {"x-admin-token": "adm"}


class LazyASGI(httpx.AsyncBaseTransport):
    """Breaks the app <-> provider reference cycle: the target app is set after both exist."""
    def __init__(self):
        self.app = None

    async def handle_async_request(self, request):
        return await httpx.ASGITransport(app=self.app).handle_async_request(request)


@pytest.fixture
async def clean():
    eng = create_async_engine(DB_URL)
    async with eng.begin() as c:
        await c.execute(text("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update"))   # test cleanup only
        await c.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
        await c.execute(text("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update"))
    await eng.dispose()


@contextlib.asynccontextmanager
async def system(slow_seconds: float = 1.0, timeout: float = 0.3, retries: int = 2):
    to_payments = LazyASGI()
    provider_app = create_provider_app(DB_URL, api_key="pk", webhook_url="http://pay/webhooks/provider",
                                       webhook_secret="whsec_test", slow_seconds=slow_seconds, webhook_transport=to_payments)
    provider = HttpProvider("http://provider", "pk", timeout, transport=httpx.ASGITransport(app=provider_app), retries=retries)
    app = create_app(Settings(database_url=DB_URL, admin_token="adm", provider_webhook_secret="whsec_test",
                              log_json=False, log_level="WARNING"), provider=provider)
    to_payments.app = app
    async with provider_app.router.lifespan_context(provider_app), app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://pay") as c:
            m = (await c.post("/admin/merchants", json={"name": "Shop", "fee_bps": 290, "fee_fixed": 30}, headers=ADMIN)).json()
            c.headers["Authorization"] = f"Bearer {m['api_key']}"
            c.app, c.provider_app, c.merchant_id = app, provider_app, m["merchant_id"]
            yield c
        await provider.aclose()


def pay_body(ref="order-1", amount=10_000, token="tok_visa", capture=True, currency="INR"):
    return {"amount": amount, "currency": currency, "payment_method": token, "merchant_reference": ref, "capture": capture}


async def pay(c, key, **kw):
    return await c.post("/payments", json=pay_body(**kw), headers={"Idempotency-Key": key})
