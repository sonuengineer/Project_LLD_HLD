"""Registration, login, refresh-token rotation with reuse detection.

Access token: short-lived JWT (15 min), stateless -> fast, but can't be revoked before expiry.
Refresh token: long-lived opaque random string, stored HASHED, single use. Each refresh returns a new
one and revokes the old one. If an already-used refresh token is presented again, someone stole it
(or the client is replaying): we revoke the ENTIRE family -> attacker and victim are both logged out,
and the victim's next login creates a fresh family.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field

EMAIL = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
from sqlalchemy import text

from bpcommon.errors import Conflict, Unauthorized

from ..core.security import create_access_token, dummy_hash, hash_password, opaque_token, sha256, verify_password
from ..db.session import global_tx


class RegisterIn(BaseModel):
    email: str = Field(pattern=EMAIL, max_length=320)
    password: str = Field(min_length=10, max_length=72)   # bcrypt ignores bytes past 72
    full_name: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    email: str = Field(pattern=EMAIL, max_length=320)
    password: str = Field(max_length=72)


class AuthService:
    def __init__(self, sm, settings):
        self.sm, self.cfg = sm, settings

    async def register(self, body: RegisterIn) -> uuid.UUID:
        # Platform admin is NOT granted by email at registration (no email verification exists, so whoever
        # registers the address first would become admin). Operators promote via `python -m saas.cli promote`.
        from sqlalchemy.exc import IntegrityError
        try:
            async with global_tx(self.sm) as s:
                exists = await s.scalar(text("SELECT 1 FROM users WHERE lower(email) = lower(:e)"), {"e": body.email})
                if exists:
                    raise Conflict("email already registered")
                return await s.scalar(text(
                    "INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, :n) RETURNING id"),
                    {"e": body.email, "h": hash_password(body.password, self.cfg.bcrypt_rounds), "n": body.full_name})
        except IntegrityError:
            raise Conflict("email already registered") from None   # concurrent duplicate registration

    async def login(self, body: LoginIn) -> dict:
        async with global_tx(self.sm) as s:
            row = (await s.execute(text("SELECT id, password_hash FROM users WHERE lower(email) = lower(:e)"),
                                   {"e": body.email})).first()
            # Same bcrypt cost whether or not the user exists -> response time doesn't reveal valid emails.
            ok = verify_password(body.password, row.password_hash if row else dummy_hash(self.cfg.bcrypt_rounds))
            if not row or not ok:
                raise Unauthorized("invalid email or password")
            return await self._issue(s, row.id, family=uuid.uuid4())

    async def _issue(self, s, user_id: uuid.UUID, family: uuid.UUID) -> dict:
        refresh = opaque_token("rt_")
        rid = await s.scalar(text(
            "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES (:u, :f, :h, :x) RETURNING id"),
            {"u": user_id, "f": family, "h": sha256(refresh),
             "x": datetime.now(timezone.utc) + timedelta(seconds=self.cfg.refresh_token_ttl_seconds)})
        return {"access_token": create_access_token(user_id, self.cfg.jwt_secret, self.cfg.access_token_ttl_seconds),
                "refresh_token": refresh, "token_type": "bearer", "expires_in": self.cfg.access_token_ttl_seconds,
                "_refresh_id": rid}

    async def refresh(self, token: str) -> dict:
        async with global_tx(self.sm) as s:
            row = (await s.execute(text(
                "SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = :h FOR UPDATE"),
                {"h": sha256(token)})).first()
            if row is None or row.expires_at < datetime.now(timezone.utc):
                raise Unauthorized("invalid refresh token")
            if row.revoked_at is not None:
                await s.execute(text("UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = :f"),
                                {"f": row.family_id})
                await s.commit()   # keep the family revocation even though we raise
                raise Unauthorized("refresh token reuse detected; all sessions in this family revoked")
            issued = await self._issue(s, row.user_id, row.family_id)
            await s.execute(text("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = :n WHERE id = :id"),
                            {"n": issued["_refresh_id"], "id": row.id})
            return issued

    async def logout(self, token: str) -> None:
        async with global_tx(self.sm) as s:
            await s.execute(text("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = "
                                 "(SELECT family_id FROM refresh_tokens WHERE token_hash = :h) AND revoked_at IS NULL"),
                            {"h": sha256(token)})
