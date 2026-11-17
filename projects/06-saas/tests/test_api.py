import asyncio

from .helpers import client, join, tenant, user


async def test_auth_flow_and_refresh_rotation_with_reuse_detection(sm, redis):
    async with client() as c:
        h, tok = await user(c, "alice@acme.io")
        assert (await c.get("/me", headers=h)).json()["email"] == "alice@acme.io"
        assert (await c.post("/auth/login", json={"email": "alice@acme.io", "password": "wrong-password"})).status_code == 401
        assert (await c.post("/auth/login", json={"email": "nobody@acme.io", "password": "x" * 12})).status_code == 401
        r1 = (await c.post("/auth/refresh", json={"refresh_token": tok["refresh_token"]})).json()
        assert r1["refresh_token"] != tok["refresh_token"]
        # The OLD token is replayed (stolen): reuse detected -> whole family revoked, incl. r1's token
        stolen = await c.post("/auth/refresh", json={"refresh_token": tok["refresh_token"]})
        assert stolen.status_code == 401 and "reuse" in stolen.json()["error"]["message"]
        assert (await c.post("/auth/refresh", json={"refresh_token": r1["refresh_token"]})).status_code == 401
        assert (await c.get("/me", headers={"Authorization": "Bearer garbage"})).status_code == 401


async def test_registration_validation(sm, redis):
    async with client() as c:
        assert (await c.post("/auth/register", json={"email": "bad", "password": "x" * 12})).status_code == 422
        assert (await c.post("/auth/register", json={"email": "a@b.co", "password": "short"})).status_code == 422
        await c.post("/auth/register", json={"email": "a@b.co", "password": "x" * 12})
        assert (await c.post("/auth/register", json={"email": "A@B.CO", "password": "x" * 12})).status_code == 409


async def test_tenant_isolation_over_http(sm, redis):
    async with client() as c:
        ah, _ = await user(c, "alice@acme.io")
        bh, _ = await user(c, "bob@globex.io")
        await tenant(c, ah, "acme")
        await tenant(c, bh, "globex")
        pa = (await c.post("/t/acme/projects", json={"name": "secret-a"}, headers=ah)).json()
        await c.post("/t/globex/projects", json={"name": "secret-b"}, headers=bh)
        assert [p["name"] for p in (await c.get("/t/acme/projects", headers=ah)).json()["projects"]] == ["secret-a"]
        # Bob can't see Acme at all, nor fetch Acme's project by id through his own tenant
        assert (await c.get("/t/acme/projects", headers=bh)).status_code == 404
        assert (await c.get(f"/t/globex/projects/{pa['id']}", headers=bh)).status_code == 404
        assert [t["slug"] for t in (await c.get("/me", headers=bh)).json()["tenants"]] == ["globex"]


async def test_tenant_aware_cache_never_crosses_tenants(sm, redis):
    async with client() as c:
        ah, _ = await user(c, "alice@acme.io")
        bh, _ = await user(c, "bob@globex.io")
        a = await tenant(c, ah, "acme")
        b = await tenant(c, bh, "globex")
        await c.post("/t/acme/projects", json={"name": "a1"}, headers=ah)
        await c.get("/t/acme/projects", headers=ah)          # cached for acme
        listed = (await c.get("/t/globex/projects", headers=bh)).json()["projects"]
        assert listed == []                                    # globex didn't get acme's cached list
        keys = sorted(k.decode() for k in await redis.keys("saas:cache:*:projects:list"))
        assert keys == sorted([f"saas:cache:{a['id']}:projects:list", f"saas:cache:{b['id']}:projects:list"])
        await c.post("/t/acme/projects", json={"name": "a2"}, headers=ah)   # write invalidates acme's entry
        assert len((await c.get("/t/acme/projects", headers=ah)).json()["projects"]) == 2


async def test_rbac_and_abac(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        viewer = await join(c, oh, "acme", "viewer@acme.io", "viewer")
        member = await join(c, oh, "acme", "member@acme.io", "member")
        assert (await c.post("/t/acme/projects", json={"name": "v"}, headers=viewer)).status_code == 403
        mine = (await c.post("/t/acme/projects", json={"name": "member-own"}, headers=member)).json()
        owners = (await c.post("/t/acme/projects", json={"name": "owner-own"}, headers=oh)).json()
        # ABAC: a member may delete a project THEY created, not someone else's
        assert (await c.delete(f"/t/acme/projects/{owners['id']}", headers=member)).status_code == 403
        assert (await c.delete(f"/t/acme/projects/{mine['id']}", headers=member)).status_code == 204
        assert (await c.get("/t/acme/audit-logs", headers=member)).status_code == 403
        assert (await c.post("/t/acme/invitations", json={"email": "x@y.io", "role": "member"},
                             headers=member)).status_code == 403


async def test_no_privilege_escalation_and_last_owner_protection(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        admin = await join(c, oh, "acme", "admin@acme.io", "admin")
        assert (await c.post("/t/acme/invitations", json={"email": "x@y.io", "role": "admin"},
                             headers=admin)).status_code == 403          # admin can't mint admins
        me = (await c.get("/me", headers=admin)).json()
        assert (await c.patch(f"/t/acme/members/{me['id']}", json={"role": "owner"},
                              headers=admin)).status_code == 403         # nor promote themselves
        owner_id = (await c.get("/me", headers=oh)).json()["id"]
        r = await c.patch(f"/t/acme/members/{owner_id}", json={"role": "admin"}, headers=oh)
        assert r.status_code == 409                                       # last owner can't be demoted
        # role change takes effect immediately (cache invalidated)
        await c.patch(f"/t/acme/members/{me['id']}", json={"role": "viewer"}, headers=oh)
        assert (await c.get("/t/acme", headers=admin)).json()["role"] == "viewer"


async def test_plan_entitlements_and_upgrade_via_billing_webhook(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        for i in range(3):
            assert (await c.post("/t/acme/projects", json={"name": f"p{i}"}, headers=oh)).status_code == 201
        r = await c.post("/t/acme/projects", json={"name": "p3"}, headers=oh)
        assert r.status_code == 403 and r.json()["error"]["code"] == "plan_limit_reached"
        r = await c.post("/t/acme/reports", headers=oh)
        assert r.status_code == 403 and r.json()["error"]["code"] == "feature_not_in_plan"
        sess = (await c.post("/t/acme/billing/checkout", json={"plan": "pro"}, headers=oh)).json()
        done = (await c.post(f"/billing/mock/checkout/{sess['checkout_session']}/complete")).json()
        assert done["webhook_status"] == 200 and done["webhook_response"]["duplicate"] is False
        assert (await c.get("/t/acme", headers=oh)).json()["plan"] == "pro"
        assert (await c.post("/t/acme/projects", json={"name": "p3"}, headers=oh)).status_code == 201
        # the provider retries the same event -> processed once
        from saas.services.billing import MockBillingProvider
        prov: MockBillingProvider = c.app.state.billing
        body = done["event"].encode()
        dup = await c.post("/billing/webhook", content=body, headers={"x-billing-signature": prov.sign(body)})
        assert dup.json()["duplicate"] is True
        forged = await c.post("/billing/webhook", content=body.replace(b"pro", b"enterprise"),
                              headers={"x-billing-signature": prov.sign(body)})
        assert forged.status_code == 401


async def test_concurrent_creates_cannot_exceed_plan_limit(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        rs = await asyncio.gather(*[c.post("/t/acme/projects", json={"name": f"p{i}"}, headers=oh) for i in range(10)])
        assert sum(r.status_code == 201 for r in rs) == 3        # FOR UPDATE on the tenant row serialises the check


async def test_api_keys_scoped_and_bounded_by_creator(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        await tenant(c, (await user(c, "bob@globex.io"))[0], "globex")
        key = (await c.post("/t/acme/api-keys", json={"name": "ci", "scopes": ["project:read"]}, headers=oh)).json()
        kh = {"Authorization": f"Bearer {key['api_key']}"}
        assert (await c.get("/t/acme/projects", headers=kh)).status_code == 200
        assert (await c.post("/t/acme/projects", json={"name": "x"}, headers=kh)).status_code == 403   # scope
        assert (await c.get("/t/globex/projects", headers=kh)).status_code == 404                       # other tenant
        assert (await c.get("/me", headers=kh)).status_code == 401                                      # user-only route
        await c.delete(f"/t/acme/api-keys/{key['id']}", headers=oh)
        assert (await c.get("/t/acme/projects", headers=kh)).status_code == 401
        member = await join(c, oh, "acme", "m@acme.io", "admin")
        r = await c.post("/t/acme/api-keys", json={"name": "x", "scopes": ["billing:manage"]}, headers=member)
        assert r.status_code == 403                                          # can't mint more power than you have


async def test_audit_log_records_actions_with_actor(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        p = (await c.post("/t/acme/projects", json={"name": "x"}, headers=oh)).json()
        await c.delete(f"/t/acme/projects/{p['id']}", headers=oh)
        actions = [a["action"] for a in (await c.get("/t/acme/audit-logs", headers=oh)).json()["audit_logs"]]
        assert actions[:3] == ["project.deleted", "project.created", "tenant.created"]
        r = await c.get("/t/acme/audit-logs/export", headers=oh)
        assert r.status_code == 403   # audit_export is a pro feature


async def test_tenant_rate_limit_and_quota(sm, redis):
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        await tenant(c, oh, "acme")
        codes = [(await c.get("/t/acme", headers=oh)).status_code for _ in range(15)]   # free: burst 10
        assert codes.count(429) >= 1 and codes[:9] == [200] * 9
        tid = (await c.get("/me", headers=oh)).json()["tenants"][0]["id"]
        from saas.services.limits import period
        await redis.set(f"saas:usage:{tid}:api_calls:{period()}", 10_000)   # simulate a month of usage
        await redis.delete(f"saas:rl:{tid}")
        r = await c.get("/t/acme", headers=oh)
        assert r.status_code == 429 and r.json()["error"]["code"] == "quota_exceeded"


async def test_platform_admin_suspension(sm, redis):
    async with client() as c:
        await user(c, "root@platform.io")
        from saas.cli import promote
        from .conftest import OWNER_URL
        assert await promote("root@platform.io", OWNER_URL)        # operator action, not registration
        root, _ = await user(c, "root@platform.io")                 # (re-login; role checked per request)
        oh, _ = await user(c, "owner@acme.io")
        t = await tenant(c, oh, "acme")
        assert (await c.get("/admin/tenants", headers=oh)).status_code == 403
        assert len((await c.get("/admin/tenants", headers=root)).json()["tenants"]) == 1
        await c.post(f"/admin/tenants/{t['id']}/status", json={"status": "suspended", "reason": "unpaid"}, headers=root)
        r = await c.get("/t/acme/projects", headers=oh)
        assert r.status_code == 403 and "suspended" in r.json()["error"]["message"]
        await c.post(f"/admin/tenants/{t['id']}/status", json={"status": "active"}, headers=root)
        assert (await c.get("/t/acme/projects", headers=oh)).status_code == 200
        usage = (await c.get(f"/admin/tenants/{t['id']}/usage", headers=root)).json()["usage"]
        assert usage and usage[0]["metric"] == "api_calls" and usage[0]["value"] >= 1   # suspended calls are rejected before metering


async def test_tenant_aware_background_job(sm, redis):
    from saas.services import jobs
    async with client() as c:
        oh, _ = await user(c, "owner@acme.io")
        bh, _ = await user(c, "bob@globex.io")
        t = await tenant(c, oh, "acme")
        await tenant(c, bh, "globex")
        await c.post("/t/globex/projects", json={"name": "globex-secret"}, headers=bh)
        await c.post("/t/acme/projects", json={"name": "acme-1"}, headers=oh)
        # upgrade acme to pro directly in DB to unlock reports
        from sqlalchemy import text
        from saas.db.session import global_tx
        async with global_tx(sm) as s:
            await s.execute(text("UPDATE tenants SET plan = 'pro' WHERE id = :t"), {"t": t["id"]})
        await c.app.state.cache.invalidate("_global", "tenant-slug:acme")
        rid = (await c.post("/t/acme/reports", headers=oh)).json()["report_id"]
        assert await jobs.process_one(c.app.state.redis, c.app.state.sm, timeout=1)
        rep = (await c.get(f"/t/acme/reports/{rid}", headers=oh)).json()
        # the handler's SQL has no tenant filter; RLS still kept globex's project out
        assert rep["status"] == "done" and rep["result"]["project_names"] == ["acme-1"]
