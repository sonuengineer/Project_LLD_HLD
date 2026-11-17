"""Regression tests for the interview-bank security review findings."""
import asyncio
import time

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from saas.core.security import dummy_hash
from saas.db.session import global_tx

from .helpers import client, join, tenant, user


async def test_no_tenant_enumeration_without_valid_credentials(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        for slug in ("acme", "does-not-exist"):
            assert (await c.get(f"/t/{slug}/projects")).status_code == 401
            assert (await c.get(f"/t/{slug}/projects", headers={"Authorization": "Bearer junk"})).status_code == 401
            assert (await c.get(f"/t/{slug}/projects", headers={"Authorization": "Bearer sk_junk"})).status_code == 401


def test_dummy_hash_has_the_same_cost_as_real_hashes():
    import bcrypt
    for rounds in (4, 12):
        assert dummy_hash(rounds).startswith(f"$2b${rounds:02d}$")
    t = time.perf_counter()
    bcrypt.checkpw(b"x", dummy_hash(10).encode())
    assert time.perf_counter() - t > 0.01            # real bcrypt work, not a cost-4 shortcut


async def test_registration_does_not_grant_platform_admin(sm, redis):
    async with client(platform_admin_emails=["root@platform.io"]) as c:
        h, _ = await user(c, "root@platform.io")
        assert (await c.get("/admin/tenants", headers=h)).status_code == 403


async def test_concurrent_duplicate_registration_is_409(sm, redis):
    async with client() as c:
        rs = await asyncio.gather(*[c.post("/auth/register", json={"email": "dup@x.io", "password": "x" * 12})
                                    for _ in range(5)])
        assert sorted(r.status_code for r in rs) == [201, 409, 409, 409, 409]


async def test_two_owners_cannot_demote_each_other_to_zero_owners(sm, redis):
    async with client() as c:
        a, _ = await user(c, "a@acme.io")
        await tenant(c, a, "acme")
        b = await join(c, a, "acme", "b@acme.io", "admin")
        bid = (await c.get("/me", headers=b)).json()["id"]
        aid = (await c.get("/me", headers=a)).json()["id"]
        await c.patch(f"/t/acme/members/{bid}", json={"role": "owner"}, headers=a)
        r1, r2 = await asyncio.gather(c.patch(f"/t/acme/members/{bid}", json={"role": "admin"}, headers=a),
                                      c.patch(f"/t/acme/members/{aid}", json={"role": "admin"}, headers=b))
        # The tenant lock serialises them: the second request comes from someone who is no longer an owner
        # (403), or would remove the last owner (409). Either way exactly one owner must remain.
        assert sorted([r1.status_code, r2.status_code])[0] == 200 and sorted([r1.status_code, r2.status_code])[1] in (403, 409)
        roles = [m["role"] for m in (await c.get("/t/acme/members", headers=a)).json()["members"]]
        assert roles.count("owner") == 1


async def test_api_key_cannot_change_roles_and_admin_cannot_demote_admin(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "o@acme.io")
        await tenant(c, oh, "acme")
        adm1 = await join(c, oh, "acme", "a1@acme.io", "admin")
        await join(c, oh, "acme", "a2@acme.io", "admin")
        members = (await c.get("/t/acme/members", headers=oh)).json()["members"]
        a2 = next(m["user_id"] for m in members if m["email"] == "a2@acme.io")
        assert (await c.patch(f"/t/acme/members/{a2}", json={"role": "viewer"}, headers=adm1)).status_code == 403
        key = (await c.post("/t/acme/api-keys", json={"name": "k", "scopes": ["member:manage"]}, headers=oh)).json()
        r = await c.patch(f"/t/acme/members/{a2}", json={"role": "viewer"}, headers={"Authorization": f"Bearer {key['api_key']}"})
        assert r.status_code == 403                                     # was a 500 (KeyError)


async def test_app_role_cannot_delete_tenants(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "o@acme.io")
        await tenant(c, oh, "acme")
    with pytest.raises(DBAPIError, match="permission denied"):
        async with global_tx(sm) as s:
            await s.execute(text("DELETE FROM tenants"))       # would cascade-erase the audit trail


async def test_stale_billing_event_does_not_override_newer_one(sm, redis):
    import json as _json
    from saas.services.billing import MockBillingProvider
    async with client() as c:
        oh, _ = await user(c, "o@acme.io")
        t = await tenant(c, oh, "acme")
        prov: MockBillingProvider = c.app.state.billing

        def event(eid, plan, created):
            body = _json.dumps({"id": eid, "type": "subscription.updated", "created": created,
                                "data": {"tenant_id": str(t["id"]), "plan": plan, "status": "active"}}).encode()
            return body, prov.sign(body)
        now = int(time.time() * 1000)
        newer, older = event("evt_new", "enterprise", now), event("evt_old", "pro", now - 60_000)
        for body, sig in (newer, older):                       # delivered out of order
            assert (await c.post("/billing/webhook", content=body, headers={"x-billing-signature": sig})).status_code == 200
        assert (await c.get("/t/acme", headers=oh)).json()["plan"] == "enterprise"


async def test_tenant_creation_is_atomic(sm, redis, monkeypatch):
    """If anything after the tenant insert fails, no ownerless tenant (or burnt slug) remains."""
    async with client() as c:
        oh, _ = await user(c, "o@acme.io")
        from saas.services import tenancy
        real_text = tenancy.text

        def failing_text(sql):
            if "INSERT INTO subscriptions" in sql:
                raise RuntimeError("crash mid-creation")
            return real_text(sql)
        monkeypatch.setattr(tenancy, "text", failing_text)
        with pytest.raises(RuntimeError):
            await c.post("/tenants", json={"slug": "acme", "name": "Acme"}, headers=oh)
        monkeypatch.setattr(tenancy, "text", real_text)
        assert (await c.post("/tenants", json={"slug": "acme", "name": "Acme"}, headers=oh)).status_code == 201
