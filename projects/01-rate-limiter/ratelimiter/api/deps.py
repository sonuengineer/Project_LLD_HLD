"""FastAPI dependencies: resolve WHO is calling, then enforce the route group's policies."""
from __future__ import annotations

import hmac

from fastapi import Depends, Header, Request, Response

from bpcommon.errors import Forbidden, Unauthorized

from ..domain.models import Identity, Plan


def client_ip(request: Request) -> str:
    settings = request.app.state.settings
    if settings.trust_forwarded_for:
        # Only our own nginx sets X-Real-IP (= $remote_addr it saw). Trusting a client-supplied
        # X-Forwarded-For without a trusted proxy lets attackers pick any IP and bypass per-IP limits.
        real = request.headers.get("x-real-ip")
        if real:
            return real.strip()
    return request.client.host if request.client else "unknown"


async def resolve_identity(request: Request, x_api_key: str | None = Header(default=None)) -> Identity:
    ip = client_ip(request)
    if not x_api_key:
        return Identity(ip=ip)
    record = await request.app.state.api_keys.lookup(x_api_key)
    if record is None:
        raise Unauthorized("Invalid API key")
    return Identity(ip=ip, user_id=record.user_id, api_key_id=record.key_id, plan=record.plan)


def rate_limited(route_group: str, cost: int = 1):
    """Dependency factory: `Depends(rate_limited("search"))` on a route."""

    async def _dep(request: Request, response: Response, identity: Identity = Depends(resolve_identity)) -> Identity:
        from ..services.rate_limit_service import raise_if_denied

        combined = await request.app.state.rate_limit_service.evaluate(identity, route_group, cost=cost)
        headers = raise_if_denied(combined)  # raises 429/503 with headers
        response.headers.update(headers)
        return identity

    return _dep


async def require_admin(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    expected = request.app.state.settings.admin_token
    # compare_digest: constant-time comparison so response timing doesn't leak the token.
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected):
        raise Forbidden("Admin token required")


__all__ = ["rate_limited", "require_admin", "resolve_identity", "Plan"]
