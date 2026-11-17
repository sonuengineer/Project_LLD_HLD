from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bpcommon.errors import NotFound, Unprocessable

from ..db.models import Endpoint
from .signing import generate_secret
from .ssrf import BlockedDestination, validate_url_syntax


class EndpointCreate(BaseModel):
    url: str = Field(max_length=2048)
    description: str = Field(default="", max_length=500)
    event_types: list[str] = Field(default_factory=lambda: ["*"], min_length=1)
    rate_limit_per_second: float | None = Field(default=None, gt=0, le=1000)

    @field_validator("event_types")
    @classmethod
    def _types(cls, v):
        import re
        for t in v:
            # Must match the publish-side pattern exactly (lowercase), or the subscription never matches.
            if t != "*" and not re.fullmatch(r"[a-z0-9_]+(\.[a-z0-9_]+)*", t):
                raise ValueError(f"invalid event type {t!r} (lowercase dotted names, or '*')")
        return v


class EndpointUpdate(BaseModel):
    url: str | None = None
    description: str | None = None
    event_types: list[str] | None = None
    rate_limit_per_second: float | None = Field(default=None, gt=0, le=1000)
    enabled: bool | None = None


def endpoint_view(e: Endpoint, *, include_secret: bool = False) -> dict:
    d = {"id": e.id, "url": e.url, "description": e.description, "event_types": e.event_types,
         "enabled": e.enabled, "disabled_reason": e.disabled_reason,
         "rate_limit_per_second": e.rate_limit_per_second, "consecutive_failures": e.consecutive_failures,
         "secret_rotation_in_progress": bool(e.previous_secret and e.previous_secret_expires_at
                                                    and e.previous_secret_expires_at > datetime.now(timezone.utc)),
         "created_at": e.created_at}
    if include_secret:
        d["secret"] = e.secret
    return d


class EndpointService:
    def __init__(self, session: AsyncSession, *, allow_private: bool, default_rate: float):
        self.s = session
        self.allow_private = allow_private
        self.default_rate = default_rate

    def _check_url(self, url: str) -> None:
        try:
            validate_url_syntax(url, allow_private=self.allow_private)
        except BlockedDestination as exc:
            raise Unprocessable(str(exc)) from None

    async def create(self, body: EndpointCreate) -> Endpoint:
        self._check_url(body.url)
        e = Endpoint(id="ep_" + secrets.token_hex(12), url=body.url, description=body.description,
                     event_types=body.event_types, secret=generate_secret(), enabled=True,
                     rate_limit_per_second=body.rate_limit_per_second or self.default_rate, consecutive_failures=0)
        self.s.add(e)
        await self.s.flush()
        await self.s.refresh(e)
        return e

    async def get(self, endpoint_id: str) -> Endpoint:
        e = await self.s.get(Endpoint, endpoint_id)
        if e is None:
            raise NotFound("endpoint not found")
        return e

    async def list(self) -> list[Endpoint]:
        return list((await self.s.scalars(select(Endpoint).order_by(Endpoint.created_at))).all())

    async def update(self, endpoint_id: str, body: EndpointUpdate) -> Endpoint:
        e = await self.get(endpoint_id)
        if body.url is not None:
            self._check_url(body.url)
            e.url = body.url
        for field in ("description", "event_types", "rate_limit_per_second"):
            if getattr(body, field) is not None:
                setattr(e, field, getattr(body, field))
        if body.enabled is not None:
            e.enabled = body.enabled
            if body.enabled:
                e.disabled_reason = None
                e.consecutive_failures = 0
        return e

    async def rotate_secret(self, endpoint_id: str, grace_seconds: int) -> Endpoint:
        """New secret signs immediately; old one ALSO signs until grace expires. The customer
        deploys the new secret whenever convenient inside the window -- zero failed deliveries."""
        e = await self.get(endpoint_id)
        e.previous_secret = e.secret
        e.previous_secret_expires_at = datetime.now(timezone.utc) + timedelta(seconds=grace_seconds)
        e.secret = generate_secret()
        return e
