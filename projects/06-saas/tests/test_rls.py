"""Row-level security, tested at the SQL level as the application role (no app code involved).
This is the defence-in-depth layer: even a buggy query can't cross tenants."""
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from saas.db.session import global_tx, tenant_tx

from .conftest import OWNER_URL


async def make_tenants(sm):
    async with global_tx(sm) as s:
        a = (await s.execute(text("INSERT INTO tenants (slug, name) VALUES ('acme', 'Acme') RETURNING id"))).scalar()
        b = (await s.execute(text("INSERT INTO tenants (slug, name) VALUES ('globex', 'Globex') RETURNING id"))).scalar()
    for t, names in ((a, ["a1", "a2"]), (b, ["b1"])):
        async with tenant_tx(sm, t) as s:
            for n in names:
                await s.execute(text("INSERT INTO projects (tenant_id, name) VALUES (:t, :n)"), {"t": t, "n": n})
    return a, b


async def test_unfiltered_query_sees_only_current_tenant(sm):
    a, b = await make_tenants(sm)
    async with tenant_tx(sm, a) as s:
        # A query that "forgot" WHERE tenant_id = ... (the classic data-leak bug)
        rows = (await s.execute(text("SELECT name FROM projects ORDER BY name"))).scalars().all()
    assert rows == ["a1", "a2"]
    async with tenant_tx(sm, b) as s:
        assert (await s.execute(text("SELECT name FROM projects"))).scalars().all() == ["b1"]


async def test_no_tenant_context_sees_nothing(sm):
    await make_tenants(sm)
    async with global_tx(sm) as s:
        assert (await s.execute(text("SELECT count(*) FROM projects"))).scalar() == 0   # fails closed


async def test_cannot_write_into_another_tenant(sm):
    a, b = await make_tenants(sm)
    with pytest.raises(DBAPIError, match="row-level security"):
        async with tenant_tx(sm, a) as s:
            await s.execute(text("INSERT INTO projects (tenant_id, name) VALUES (:t, 'evil')"), {"t": b})


async def test_cannot_update_or_delete_other_tenants_rows(sm):
    a, b = await make_tenants(sm)
    async with tenant_tx(sm, a) as s:
        upd = await s.execute(text("UPDATE projects SET name = 'pwned' WHERE tenant_id = :b"), {"b": b})
        dele = await s.execute(text("DELETE FROM projects"))
        assert upd.rowcount == 0 and dele.rowcount == 2          # only A's own rows were affected
    async with tenant_tx(sm, b) as s:
        assert (await s.execute(text("SELECT name FROM projects"))).scalars().all() == ["b1"]


async def test_context_does_not_leak_between_transactions(sm):
    a, b = await make_tenants(sm)
    async with tenant_tx(sm, a) as s:
        await s.execute(text("SELECT 1"))
    # Same pool, likely the same physical connection: SET LOCAL ended with the previous transaction.
    async with sm() as s, s.begin():
        assert (await s.execute(text("SELECT current_setting('app.tenant_id', true)"))).scalar() in (None, "")
        assert (await s.execute(text("SELECT count(*) FROM projects"))).scalar() == 0


async def test_audit_log_is_append_only_for_the_app(sm):
    a, _ = await make_tenants(sm)
    async with tenant_tx(sm, a) as s:
        await s.execute(text("INSERT INTO audit_logs (tenant_id, action) VALUES (:t, 'x')"), {"t": a})
    with pytest.raises(DBAPIError, match="permission denied"):
        async with tenant_tx(sm, a) as s:
            await s.execute(text("UPDATE audit_logs SET action = 'covered-up'"))
    with pytest.raises(DBAPIError, match="permission denied"):
        async with tenant_tx(sm, a) as s:
            await s.execute(text("DELETE FROM audit_logs"))


async def test_superuser_would_bypass_rls(sm):
    """Why the app must NOT use the superuser: superusers ignore RLS entirely."""
    from saas.db.session import make_engine, make_sessionmaker
    await make_tenants(sm)
    owner = make_engine(OWNER_URL)
    async with tenant_tx(make_sessionmaker(owner), uuid.uuid4()) as s:
        assert (await s.execute(text("SELECT count(*) FROM projects"))).scalar() == 3   # sees everything
    await owner.dispose()


async def test_api_key_resolution_via_security_definer(sm):
    a, _ = await make_tenants(sm)
    async with tenant_tx(sm, a) as s:
        await s.execute(text("INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes) "
                             "VALUES (:t, 'ci', 'sk_ab', 'hash123', ARRAY['project:read'])"), {"t": a})
    async with global_tx(sm) as s:
        assert (await s.execute(text("SELECT count(*) FROM api_keys"))).scalar() == 0          # hidden by RLS
        row = (await s.execute(text("SELECT * FROM resolve_api_key('hash123')"))).one()      # narrow, exact lookup
        assert row.tenant_id == a and row.scopes == ["project:read"]


async def test_unfiltered_membership_query_cannot_return_other_tenant_roles(sm):
    """Regression for the privilege-escalation bug: a user's membership in tenant B must be invisible
    inside tenant A's context, even to a query filtering only by user_id."""
    a, b = await make_tenants(sm)
    async with global_tx(sm) as s:
        uid = (await s.execute(text("INSERT INTO users (email, password_hash) VALUES ('bob@x.io', 'h') RETURNING id"))).scalar()
    async with tenant_tx(sm, b, uid) as s:
        await s.execute(text("INSERT INTO memberships (tenant_id, user_id, role) VALUES (:t, :u, 'owner')"), {"t": b, "u": uid})
    async with tenant_tx(sm, a, uid) as s:
        assert (await s.execute(text("SELECT role FROM memberships WHERE user_id = :u"), {"u": uid})).first() is None
    async with global_tx(sm, uid) as s:
        rows = (await s.execute(text("SELECT slug, role FROM user_tenants(:u)"), {"u": uid})).all()
    assert [(r.slug, r.role) for r in rows] == [("globex", "owner")]
