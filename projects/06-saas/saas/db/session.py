"""Tenant-scoped transactions.

Every request that touches tenant data runs inside tenant_tx(), which does
    SET LOCAL app.tenant_id = '<uuid>'   (and app.user_id)
at the start of the transaction. Postgres RLS policies compare each row's tenant_id with that setting.
SET LOCAL lasts only until COMMIT/ROLLBACK, so a pooled connection can never leak one tenant's
context into the next request -- the reason we don't use plain SET (session-scoped).
"""
from __future__ import annotations

import contextlib
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine


def make_engine(url: str) -> AsyncEngine:
    return create_async_engine(url, pool_size=10, max_overflow=10, pool_pre_ping=True)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)


@contextlib.asynccontextmanager
async def tenant_tx(sm: async_sessionmaker, tenant_id: uuid.UUID | None, user_id: uuid.UUID | None = None):
    async with sm() as s, s.begin():
        # set_config(name, value, is_local=true) == SET LOCAL, but parameterised (no SQL injection).
        await s.execute(text("SELECT set_config('app.tenant_id', :t, true), set_config('app.user_id', :u, true)"),
                        {"t": str(tenant_id) if tenant_id else "", "u": str(user_id) if user_id else ""})
        yield s


@contextlib.asynccontextmanager
async def global_tx(sm: async_sessionmaker, user_id: uuid.UUID | None = None):
    """No tenant context: tenant tables return no rows (RLS fails closed). For users/tenants/auth."""
    async with tenant_tx(sm, None, user_id) as s:
        yield s
