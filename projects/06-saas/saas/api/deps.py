"""Authentication -> tenant resolution -> authorization context (Principal) for every request."""
from __future__ import annotations

import uuid

import jwt
from fastapi import Depends, Header, Request
from sqlalchemy import text

from bpcommon.errors import Forbidden, NotFound, Unauthorized
from bpcommon.logging import request_id_var

from ..core.plans import get_plan
from ..core.principal import Principal
from ..core.rbac import ROLE_PERMISSIONS, P
from ..core.security import API_KEY_PREFIX, decode_access_token, sha256
from ..db.session import global_tx, tenant_tx


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthorized("missing bearer token")
    return authorization[7:].strip()


async def current_user_id(request: Request, authorization: str | None = Header(default=None)) -> uuid.UUID:
    token = _bearer(authorization)
    if token.startswith(API_KEY_PREFIX):
        raise Unauthorized("this endpoint needs a user token, not an API key")
    try:
        return decode_access_token(token, request.app.state.settings.jwt_secret)
    except jwt.PyJWTError:
        raise Unauthorized("invalid or expired token") from None


async def _tenant_by_slug(request: Request, slug: str) -> dict:
    sm, cache = request.app.state.sm, request.app.state.cache

    async def load():
        async with global_tx(sm) as s:
            row = (await s.execute(text("SELECT id, slug, name, plan, status FROM tenants WHERE slug = :s"),
                                   {"s": slug})).mappings().first()
            return dict(row) if row else None
    t = await cache.get_or_load("_global", f"tenant-slug:{slug}", load)
    if t is None:
        raise NotFound("tenant not found")
    return t


async def tenant_principal(request: Request, slug: str, authorization: str | None = Header(default=None)) -> Principal:
    app = request.app
    # Authenticate BEFORE resolving the tenant: otherwise anonymous callers could tell existing slugs (401)
    # from missing ones (404) -- tenant enumeration (found in review).
    token = _bearer(authorization)
    key = user_id = None
    if token.startswith(API_KEY_PREFIX):
        async with global_tx(app.state.sm) as s:
            key = (await s.execute(text("SELECT * FROM resolve_api_key(:h)"), {"h": sha256(token)})).first()
        if key is None:
            raise Unauthorized("invalid API key")
    else:
        try:
            user_id = decode_access_token(token, app.state.settings.jwt_secret)
        except jwt.PyJWTError:
            raise Unauthorized("invalid or expired token") from None
    tenant = await _tenant_by_slug(request, slug)
    tid = uuid.UUID(str(tenant["id"]))
    if key is not None:
        if key.tenant_id != tid:
            raise NotFound("tenant not found")   # don't confirm the tenant exists to a foreign key
        async with tenant_tx(app.state.sm, tid) as s:
            creator_role = await s.scalar(text("SELECT role FROM memberships WHERE tenant_id = :t AND user_id = :u"),
                                          {"t": tid, "u": key.created_by})
        # A key can't outlive its creator's power: scopes AND the creator's CURRENT role.
        perms = frozenset(P(x) for x in key.scopes) & (ROLE_PERMISSIONS.get(creator_role, frozenset()))
        principal = Principal(tid, tenant["slug"], get_plan(tenant["plan"]), perms, api_key_id=key.key_id)
    else:
        async def load_role():
            async with tenant_tx(app.state.sm, tid, user_id) as s:
                # Explicit tenant filter as well as RLS: belt and braces on the most sensitive lookup.
                return await s.scalar(text("SELECT role FROM memberships WHERE tenant_id = :t AND user_id = :u"),
                                      {"t": tid, "u": user_id})
        role = await app.state.cache.get_or_load(tid, f"member-role:{user_id}", load_role)
        if role is None:
            raise NotFound("tenant not found")   # non-members can't even learn the tenant exists
        principal = Principal(tid, tenant["slug"], get_plan(tenant["plan"]), ROLE_PERMISSIONS[role], role=role,
                              user_id=user_id)
    if tenant["status"] == "suspended":
        raise Forbidden("tenant is suspended", details={"tenant": slug})
    principal.ip = request.client.host if request.client else None
    principal.request_id = request_id_var.get()
    await app.state.limits.check_rate(tid, principal.plan)
    await app.state.limits.meter(tid, principal.plan)
    return principal


async def platform_admin(request: Request, user_id: uuid.UUID = Depends(current_user_id)) -> uuid.UUID:
    async with global_tx(request.app.state.sm) as s:
        ok = await s.scalar(text("SELECT is_platform_admin FROM users WHERE id = :u"), {"u": user_id})
    if not ok:
        raise Forbidden("platform admin only")
    return user_id
