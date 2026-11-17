from __future__ import annotations

import csv
import io
import uuid

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from bpcommon.errors import NotFound

from ..core.principal import Principal
from ..core.rbac import P
from ..db.session import global_tx, tenant_tx
from ..services import audit, jobs, tenancy
from ..services.auth import AuthService, LoginIn, RegisterIn
from ..services.billing import apply_event
from .deps import current_user_id, platform_admin, tenant_principal

auth = APIRouter(prefix="/auth", tags=["auth"])
me = APIRouter(tags=["me"])
t = APIRouter(prefix="/t/{slug}", tags=["tenant"])
billing = APIRouter(prefix="/billing", tags=["billing"])
admin = APIRouter(prefix="/admin", tags=["platform admin"])


def _auth(request: Request) -> AuthService:
    return AuthService(request.app.state.sm, request.app.state.settings)


def _tx(request: Request, p: Principal):
    return tenant_tx(request.app.state.sm, p.tenant_id, p.user_id)


class RefreshIn(BaseModel):
    refresh_token: str


@auth.post("/register", status_code=201)
async def register(body: RegisterIn, request: Request):
    return {"user_id": await _auth(request).register(body)}


@auth.post("/login")
async def login(body: LoginIn, request: Request):
    out = await _auth(request).login(body)
    out.pop("_refresh_id")
    return out


@auth.post("/refresh")
async def refresh(body: RefreshIn, request: Request):
    out = await _auth(request).refresh(body.refresh_token)
    out.pop("_refresh_id")
    return out


@auth.post("/logout", status_code=204)
async def logout(body: RefreshIn, request: Request):
    await _auth(request).logout(body.refresh_token)


@me.get("/me")
async def whoami(request: Request, user_id: uuid.UUID = Depends(current_user_id)):
    async with global_tx(request.app.state.sm, user_id) as s:
        u = (await s.execute(text("SELECT id, email, full_name, is_platform_admin FROM users WHERE id = :u"),
                             {"u": user_id})).mappings().one()
    return {**u, "tenants": await tenancy.my_tenants(request.app.state.sm, user_id)}


@me.post("/tenants", status_code=201)
async def create_tenant(body: tenancy.TenantCreate, request: Request, user_id: uuid.UUID = Depends(current_user_id)):
    return await tenancy.create_tenant(request.app.state.sm, user_id, body)


class AcceptIn(BaseModel):
    token: str


@me.post("/invitations/accept")
async def accept(body: AcceptIn, request: Request, user_id: uuid.UUID = Depends(current_user_id)):
    async with global_tx(request.app.state.sm) as s:
        email = await s.scalar(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})
    return await tenancy.accept_invitation(request.app.state.sm, user_id, email, body.token)


# ---- tenant-scoped -------------------------------------------------------------------------------
@t.get("")
async def tenant_info(p: Principal = Depends(tenant_principal)):
    return {"id": p.tenant_id, "slug": p.tenant_slug, "plan": p.plan.name, "role": p.role,
            "permissions": sorted(x.value for x in p.permissions), "features": sorted(p.plan.features),
            "limits": {"max_projects": p.plan.max_projects, "max_members": p.plan.max_members,
                       "requests_per_second": p.plan.requests_per_second, "monthly_api_calls": p.plan.monthly_api_calls}}


@t.get("/members")
async def members(request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.MEMBER_READ)
    async with _tx(request, p) as s:
        return {"members": await tenancy.list_members(s)}


@t.post("/invitations", status_code=201)
async def invite(body: tenancy.InviteIn, request: Request, p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        return await tenancy.invite(s, p, body)


@t.patch("/members/{user_id}")
async def change_role(user_id: uuid.UUID, body: tenancy.RoleChange, request: Request,
                      p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        await tenancy.change_role(s, p, user_id, body)
    await request.app.state.cache.invalidate(p.tenant_id, f"member-role:{user_id}")
    return {"user_id": user_id, "role": body.role}


@t.delete("/members/{user_id}", status_code=204)
async def remove_member(user_id: uuid.UUID, request: Request, p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        await tenancy.remove_member(s, p, user_id)
    await request.app.state.cache.invalidate(p.tenant_id, f"member-role:{user_id}")


@t.get("/projects")
async def list_projects(request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.PROJECT_READ)
    cache = request.app.state.cache

    async def load():
        async with _tx(request, p) as s:
            return await tenancy.list_projects(s)
    return {"projects": await cache.get_or_load(p.tenant_id, "projects:list", load)}


@t.post("/projects", status_code=201)
async def create_project(body: tenancy.ProjectIn, request: Request, p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        out = await tenancy.create_project(s, p, body)
    await request.app.state.cache.invalidate(p.tenant_id, "projects:list")
    return out


@t.get("/projects/{project_id}")
async def get_project(project_id: uuid.UUID, request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.PROJECT_READ)
    async with _tx(request, p) as s:
        return await tenancy.get_project(s, project_id)


@t.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, request: Request, p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        await tenancy.delete_project(s, p, project_id)
    await request.app.state.cache.invalidate(p.tenant_id, "projects:list")


@t.post("/api-keys", status_code=201)
async def create_key(body: tenancy.ApiKeyIn, request: Request, p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        return await tenancy.create_api_key(s, p, body)


@t.get("/api-keys")
async def list_keys(request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.APIKEY_MANAGE)
    async with _tx(request, p) as s:
        return {"api_keys": await tenancy.list_api_keys(s)}


@t.delete("/api-keys/{key_id}", status_code=204)
async def revoke_key(key_id: uuid.UUID, request: Request, p: Principal = Depends(tenant_principal)):
    async with _tx(request, p) as s:
        await tenancy.revoke_api_key(s, p, key_id)


@t.get("/audit-logs")
async def audit_logs(request: Request, p: Principal = Depends(tenant_principal), limit: int = Query(100, le=1000)):
    p.require(P.AUDIT_READ)
    async with _tx(request, p) as s:
        rows = (await s.execute(text("SELECT id, actor_user_id, actor_api_key_id, action, target_type, target_id, "
                                     "metadata, ip, created_at FROM audit_logs ORDER BY id DESC LIMIT :l"),
                                {"l": limit})).mappings().all()
    return {"audit_logs": [dict(r) for r in rows]}


@t.get("/audit-logs/export", response_class=PlainTextResponse)
async def audit_export(request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.AUDIT_READ)
    p.require_feature("audit_export")
    async with _tx(request, p) as s:
        rows = (await s.execute(text("SELECT created_at, action, actor_user_id, target_type, target_id FROM audit_logs "
                                     "ORDER BY id"))).all()
        await audit.record(s, p, "audit.exported", rows=len(rows))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["created_at", "action", "actor_user_id", "target_type", "target_id"])
    w.writerows(rows)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@t.get("/usage")
async def usage(request: Request, p: Principal = Depends(tenant_principal)):
    from ..services.limits import period
    from redis.exceptions import RedisError
    try:
        used = int(await request.app.state.redis.get(f"saas:usage:{p.tenant_id}:api_calls:{period()}") or 0)
    except RedisError:
        used = None      # metering store unavailable: report unknown instead of a 500
    return {"period": period(), "api_calls": used, "monthly_quota": p.plan.monthly_api_calls}


@t.post("/reports", status_code=202)
async def run_report(request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.REPORT_RUN)
    p.require_feature("reports")
    async with _tx(request, p) as s:
        rid = await s.scalar(text("INSERT INTO reports (tenant_id, kind) VALUES (:t, 'project_report') RETURNING id"),
                             {"t": p.tenant_id})
        await audit.record(s, p, "report.requested", "report", rid)
    await jobs.enqueue(request.app.state.redis, p.tenant_id, "project_report", {"report_id": str(rid)})
    return {"report_id": rid, "status": "queued"}


@t.get("/reports/{report_id}")
async def get_report(report_id: uuid.UUID, request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.PROJECT_READ)
    async with _tx(request, p) as s:
        row = (await s.execute(text("SELECT id, kind, status, result, created_at, finished_at FROM reports WHERE id = :i"),
                               {"i": report_id})).mappings().first()
    if row is None:
        raise NotFound("report not found")
    return dict(row)


class CheckoutIn(BaseModel):
    plan: str = Field(pattern=r"^(free|pro|enterprise)$")


@t.post("/billing/checkout")
async def checkout(body: CheckoutIn, request: Request, p: Principal = Depends(tenant_principal)):
    p.require(P.BILLING_MANAGE)
    sess = await request.app.state.billing.create_checkout(str(p.tenant_id), body.plan)
    async with _tx(request, p) as s:
        await audit.record(s, p, "billing.checkout_started", "checkout", sess.id, plan=body.plan)
    return {"checkout_session": sess.id, "url": sess.url}


# ---- billing provider callbacks (no user auth: authenticated by signature) ------------------------
@billing.post("/webhook")
async def billing_webhook(request: Request):
    raw = await request.body()
    provider = request.app.state.billing
    evt = provider.verify_and_parse(raw, request.headers.get("x-billing-signature"))
    processed = await apply_event(request.app.state.sm, provider.name, evt, raw)
    await _invalidate_tenant_cache(request, evt.tenant_id)
    return {"received": True, "duplicate": not processed}


@billing.post("/mock/checkout/{session_id}/complete")
async def mock_complete(session_id: str, request: Request):
    """Demo/test only: pretend the customer paid; the 'provider' then calls our webhook."""
    body, sig = request.app.state.billing.complete(session_id)
    import httpx
    transport = httpx.ASGITransport(app=request.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://self") as c:
        r = await c.post("/billing/webhook", content=body, headers={"x-billing-signature": sig,
                                                                    "content-type": "application/json"})
    return {"webhook_status": r.status_code, "webhook_response": r.json(), "event": body.decode()}


async def _invalidate_tenant_cache(request: Request, tenant_id) -> None:
    async with global_tx(request.app.state.sm) as s:
        slug = await s.scalar(text("SELECT slug FROM tenants WHERE id = :t"), {"t": tenant_id})
    if slug:
        await request.app.state.cache.invalidate("_global", f"tenant-slug:{slug}")


# ---- platform admin ------------------------------------------------------------------------------
@admin.get("/tenants")
async def all_tenants(request: Request, _: uuid.UUID = Depends(platform_admin)):
    async with global_tx(request.app.state.sm) as s:
        rows = (await s.execute(text("SELECT id, slug, name, plan, status, created_at FROM tenants ORDER BY created_at"))
                ).mappings().all()
    return {"tenants": [dict(r) for r in rows]}


class StatusIn(BaseModel):
    status: str = Field(pattern=r"^(active|suspended)$")
    reason: str = Field(default="", max_length=500)


@admin.post("/tenants/{tenant_id}/status")
async def set_status(tenant_id: uuid.UUID, body: StatusIn, request: Request, admin_id: uuid.UUID = Depends(platform_admin)):
    async with global_tx(request.app.state.sm) as s:
        res = await s.execute(text("UPDATE tenants SET status = :st WHERE id = :t"), {"st": body.status, "t": tenant_id})
        if res.rowcount == 0:
            raise NotFound("tenant not found")
    async with tenant_tx(request.app.state.sm, tenant_id, admin_id) as s:   # admin acts inside the tenant: audited
        import json
        await s.execute(text("INSERT INTO audit_logs (tenant_id, actor_user_id, action, metadata) "
                             "VALUES (:t, :u, :a, CAST(:m AS jsonb))"),
                        {"t": tenant_id, "u": admin_id, "a": f"platform.tenant_{body.status}",
                         "m": json.dumps({"reason": body.reason})})
    await _invalidate_tenant_cache(request, tenant_id)
    return {"tenant_id": tenant_id, "status": body.status}


@admin.get("/tenants/{tenant_id}/usage")
async def tenant_usage(tenant_id: uuid.UUID, request: Request, _: uuid.UUID = Depends(platform_admin)):
    await request.app.state.limits.flush_usage_to_db(request.app.state.sm)
    async with tenant_tx(request.app.state.sm, tenant_id) as s:
        rows = (await s.execute(text("SELECT metric, period, value FROM usage_counters ORDER BY period"))).mappings().all()
    return {"tenant_id": tenant_id, "usage": [dict(r) for r in rows]}


@admin.post("/usage/flush")
async def flush(request: Request, _: uuid.UUID = Depends(platform_admin)):
    return {"counters_flushed": await request.app.state.limits.flush_usage_to_db(request.app.state.sm)}
