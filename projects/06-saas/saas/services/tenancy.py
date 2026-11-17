"""Tenants, memberships, invitations, projects, API keys."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from bpcommon.errors import Conflict, Forbidden, NotFound

from ..core.principal import Principal
from ..core.rbac import P, ROLE_PERMISSIONS, ROLE_RANK, can_assign_role, can_delete_project
from ..core.security import API_KEY_PREFIX, opaque_token, sha256
from ..db.session import global_tx, tenant_tx
from . import audit
from .errors import PlanLimitReached

EMAIL = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class TenantCreate(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9-]{3,40}$")
    name: str = Field(min_length=1, max_length=200)


class InviteIn(BaseModel):
    email: str = Field(pattern=EMAIL, max_length=320)
    role: str = Field(pattern=r"^(admin|member|viewer)$")


class RoleChange(BaseModel):
    role: str = Field(pattern=r"^(owner|admin|member|viewer)$")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)


class ApiKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    scopes: list[P] = Field(min_length=1)


async def create_tenant(sm, user_id: uuid.UUID, body: TenantCreate) -> dict:
    """ONE transaction: tenant + owner membership + subscription + audit. (Two transactions could leave a
    tenant with no owner and a slug nobody can reuse -- found in review.)"""
    try:
        async with sm() as s, s.begin():
            tid = await s.scalar(text("INSERT INTO tenants (slug, name) VALUES (:s, :n) RETURNING id"),
                                 {"s": body.slug, "n": body.name})
            # Enter the new tenant's RLS context inside the same transaction.
            await s.execute(text("SELECT set_config('app.tenant_id', :t, true), set_config('app.user_id', :u, true)"),
                            {"t": str(tid), "u": str(user_id)})
            await s.execute(text("INSERT INTO memberships (tenant_id, user_id, role) VALUES (:t, :u, 'owner')"),
                            {"t": tid, "u": user_id})
            await s.execute(text("INSERT INTO subscriptions (tenant_id, plan, status, provider) VALUES (:t, 'free', 'active', 'none')"),
                            {"t": tid})
            # Separate :tt param: asyncpg infers ONE type per parameter, and target_id is text, tenant_id uuid.
            await s.execute(text("INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, target_id) "
                                 "VALUES (:t, :u, 'tenant.created', 'tenant', :tt)"), {"t": tid, "u": user_id, "tt": str(tid)})
    except IntegrityError:
        raise Conflict("slug already taken") from None
    return {"id": tid, "slug": body.slug, "name": body.name, "plan": "free", "role": "owner"}


async def _lock_tenant(s, tenant_id) -> str:
    """Serialise membership changes per tenant (count-then-act checks must not race)."""
    return await s.scalar(text("SELECT status FROM tenants WHERE id = :t FOR UPDATE"), {"t": tenant_id})


async def my_tenants(sm, user_id: uuid.UUID) -> list[dict]:
    # Cross-tenant by nature -> narrow SECURITY DEFINER function, so the memberships RLS policy can stay
    # strictly tenant-scoped (see migration 0003 for the bug the looser policy caused).
    async with global_tx(sm, user_id) as s:
        rows = (await s.execute(text("SELECT * FROM user_tenants(:u)"), {"u": user_id})).mappings().all()
    return [dict(r) for r in rows]


# ---- members ------------------------------------------------------------------------------------
async def list_members(s) -> list[dict]:
    # (RLS already scopes this; users table is global, so the join relies on the memberships filter.)
    rows = (await s.execute(text("SELECT m.user_id, u.email, u.full_name, m.role, m.created_at FROM memberships m "
                                 "JOIN users u ON u.id = m.user_id ORDER BY m.created_at"))).mappings().all()
    return [dict(r) for r in rows]


async def invite(s, p: Principal, body: InviteIn) -> dict:
    p.require(P.MEMBER_INVITE)
    if not can_assign_role(p.role or "viewer", body.role):
        raise Forbidden("cannot invite with a role equal to or above your own")
    await _lock_tenant(s, p.tenant_id)
    members = await s.scalar(text("SELECT count(*) FROM memberships"))
    pending = await s.scalar(text("SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND expires_at > now()"))
    if p.plan.max_members is not None and members + pending >= p.plan.max_members:
        raise PlanLimitReached(f"plan '{p.plan.name}' allows {p.plan.max_members} members",
                               details={"limit": p.plan.max_members, "members": members, "pending": pending})
    token = opaque_token("inv_")
    iid = await s.scalar(text(
        "INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at) "
        "VALUES (:t, :e, :r, :h, :u, :x) RETURNING id"),
        {"t": p.tenant_id, "e": body.email.lower(), "r": body.role, "h": sha256(token), "u": p.user_id,
         "x": datetime.now(timezone.utc) + timedelta(days=7)})
    await audit.record(s, p, "member.invited", "invitation", iid, email=body.email.lower(), role=body.role)
    # Email delivery is out of scope: the token is returned to the inviter (dev/demo behaviour).
    return {"invitation_id": iid, "token": token, "expires_in_days": 7}


async def accept_invitation(sm, user_id: uuid.UUID, email: str, token: str) -> dict:
    # We don't know the tenant until we read the invitation, and RLS hides invitations without tenant
    # context -> a narrow SECURITY DEFINER function looks it up by exact token hash only.
    async with global_tx(sm, user_id) as s:
        row = (await s.execute(text("SELECT * FROM accept_invitation_lookup(:h)"), {"h": sha256(token)})).first()
    if row is None:
        raise NotFound("invitation not found or expired")
    if row.email != email.lower():
        raise Forbidden("this invitation was sent to a different email address")
    async with tenant_tx(sm, row.tenant_id, user_id) as s:
        status = await _lock_tenant(s, row.tenant_id)
        if status != "active":
            raise Forbidden("tenant is suspended")
        plan = await s.scalar(text("SELECT plan FROM tenants WHERE id = :t"), {"t": row.tenant_id})
        from ..core.plans import get_plan
        limit = get_plan(plan).max_members
        if limit is not None and await s.scalar(text("SELECT count(*) FROM memberships")) >= limit:
            raise PlanLimitReached(f"plan '{plan}' allows {limit} members")   # re-checked at acceptance time
        try:
            await s.execute(text("INSERT INTO memberships (tenant_id, user_id, role) VALUES (:t, :u, :r)"),
                            {"t": row.tenant_id, "u": user_id, "r": row.role})
        except IntegrityError:
            raise Conflict("already a member") from None
        await s.execute(text("UPDATE invitations SET accepted_at = now() WHERE id = :i"), {"i": row.id})
        await s.execute(text("INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, target_id) "
                             "VALUES (:t, :u, 'member.joined', 'user', :ut)"),
                        {"t": row.tenant_id, "u": user_id, "ut": str(user_id)})
    return {"tenant_id": row.tenant_id, "role": row.role}


async def _owner_count(s) -> int:
    return await s.scalar(text("SELECT count(*) FROM memberships WHERE role = 'owner'"))


async def change_role(s, p: Principal, user_id: uuid.UUID, body: RoleChange) -> None:
    p.require(P.MEMBER_MANAGE)
    if p.role is None:
        raise Forbidden("membership changes require a user session, not an API key")   # was a 500 (KeyError)
    await _lock_tenant(s, p.tenant_id)          # two owners demoting each other can't both pass the count
    current = await s.scalar(text("SELECT role FROM memberships WHERE tenant_id = :t AND user_id = :u"),
                             {"t": p.tenant_id, "u": user_id})
    if current is None:
        raise NotFound("member not found")
    if body.role == "owner" and p.role != "owner":
        raise Forbidden("only owners can grant owner")
    if body.role != "owner" and not can_assign_role(p.role, body.role) and p.role != "owner":
        raise Forbidden("cannot assign a role equal to or above your own")
    if current == "owner" and p.role != "owner":
        raise Forbidden("only owners can change an owner's role")
    if p.role != "owner" and ROLE_RANK[current] >= ROLE_RANK[p.role]:
        raise Forbidden("you can only change roles of members below your own role")
    if current == "owner" and body.role != "owner" and await _owner_count(s) == 1:
        raise Conflict("cannot demote the last owner")
    await s.execute(text("UPDATE memberships SET role = :r WHERE tenant_id = :t AND user_id = :u"),
                    {"r": body.role, "t": p.tenant_id, "u": user_id})
    await audit.record(s, p, "member.role_changed", "user", user_id, old=current, new=body.role)


async def remove_member(s, p: Principal, user_id: uuid.UUID) -> None:
    if user_id != p.user_id:
        p.require(P.MEMBER_MANAGE)
        if p.role is None:
            raise Forbidden("membership changes require a user session, not an API key")
    await _lock_tenant(s, p.tenant_id)
    role = await s.scalar(text("SELECT role FROM memberships WHERE tenant_id = :t AND user_id = :u"),
                          {"t": p.tenant_id, "u": user_id})
    if role is None:
        raise NotFound("member not found")
    if role == "owner" and await _owner_count(s) == 1:
        raise Conflict("cannot remove the last owner")
    if role == "owner" and p.role != "owner":
        raise Forbidden("only owners can remove an owner")
    if user_id != p.user_id and p.role != "owner" and ROLE_RANK[role] >= ROLE_RANK[p.role]:
        raise Forbidden("you can only remove members below your own role")
    await s.execute(text("DELETE FROM memberships WHERE tenant_id = :t AND user_id = :u"), {"t": p.tenant_id, "u": user_id})
    await audit.record(s, p, "member.removed", "user", user_id, role=role)


# ---- projects -----------------------------------------------------------------------------------
async def list_projects(s, limit: int = 100) -> list[dict]:
    rows = (await s.execute(text("SELECT id, name, description, created_by, created_at FROM projects "
                                 "ORDER BY created_at DESC LIMIT :l"), {"l": limit})).mappings().all()
    return [dict(r) for r in rows]


async def create_project(s, p: Principal, body: ProjectIn) -> dict:
    p.require(P.PROJECT_WRITE)
    if p.plan.max_projects is not None:
        # Lock the tenant's row so two concurrent creates can't both pass the count check (race).
        await s.execute(text("SELECT 1 FROM tenants WHERE id = :t FOR UPDATE"), {"t": p.tenant_id})
        count = await s.scalar(text("SELECT count(*) FROM projects"))
        if count >= p.plan.max_projects:
            raise PlanLimitReached(f"plan '{p.plan.name}' allows {p.plan.max_projects} projects",
                                   details={"limit": p.plan.max_projects, "current": count})
    try:
        row = (await s.execute(text(
            "INSERT INTO projects (tenant_id, name, description, created_by) VALUES (:t, :n, :d, :u) "
            "RETURNING id, name, description, created_by, created_at"),
            {"t": p.tenant_id, "n": body.name, "d": body.description, "u": p.user_id})).mappings().one()
    except IntegrityError:
        raise Conflict("a project with this name already exists") from None
    await audit.record(s, p, "project.created", "project", row["id"], name=body.name)
    return dict(row)


async def get_project(s, project_id: uuid.UUID) -> dict:
    row = (await s.execute(text("SELECT id, name, description, created_by, created_at FROM projects WHERE id = :i"),
                           {"i": project_id})).mappings().first()
    if row is None:
        raise NotFound("project not found")   # other tenants' projects are invisible -> 404, not 403
    return dict(row)


async def delete_project(s, p: Principal, project_id: uuid.UUID) -> None:
    proj = await get_project(s, project_id)
    if not can_delete_project(p.permissions, p.user_id, proj["created_by"]):
        raise Forbidden("only admins or the project's creator can delete it")
    await s.execute(text("DELETE FROM projects WHERE id = :i"), {"i": project_id})
    await audit.record(s, p, "project.deleted", "project", project_id, name=proj["name"])


# ---- API keys -----------------------------------------------------------------------------------
async def create_api_key(s, p: Principal, body: ApiKeyIn) -> dict:
    p.require(P.APIKEY_MANAGE)
    too_much = set(body.scopes) - set(p.permissions)
    if too_much:   # a key can never have more power than the person who created it
        raise Forbidden("scopes exceed your own permissions", details={"scopes": sorted(too_much)})
    raw = opaque_token(API_KEY_PREFIX)
    kid = await s.scalar(text(
        "INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes, created_by) "
        "VALUES (:t, :n, :p, :h, :s, :u) RETURNING id"),
        {"t": p.tenant_id, "n": body.name, "p": raw[:10], "h": sha256(raw), "s": [x.value for x in body.scopes],
         "u": p.user_id})
    await audit.record(s, p, "apikey.created", "api_key", kid, name=body.name, scopes=[x.value for x in body.scopes])
    return {"id": kid, "api_key": raw, "prefix": raw[:10], "scopes": [x.value for x in body.scopes],
            "note": "shown once; only a hash is stored"}


async def list_api_keys(s) -> list[dict]:
    rows = (await s.execute(text("SELECT id, name, prefix, scopes, created_by, last_used_at, revoked_at, created_at "
                                 "FROM api_keys ORDER BY created_at"))).mappings().all()
    return [dict(r) for r in rows]


async def revoke_api_key(s, p: Principal, key_id: uuid.UUID) -> None:
    p.require(P.APIKEY_MANAGE)
    res = await s.execute(text("UPDATE api_keys SET revoked_at = now() WHERE id = :i AND revoked_at IS NULL"), {"i": key_id})
    if res.rowcount == 0:
        raise NotFound("api key not found or already revoked")
    await audit.record(s, p, "apikey.revoked", "api_key", key_id)


def permissions_for_role(role: str):
    return ROLE_PERMISSIONS[role]

