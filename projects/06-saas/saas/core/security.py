"""Passwords, JWT access tokens, opaque tokens (refresh, invitations, API keys)."""
from __future__ import annotations

import hashlib
import secrets
import time
import uuid

import bcrypt
import jwt

API_KEY_PREFIX = "sk_"


def hash_password(password: str, rounds: int = 12) -> str:
    # bcrypt: deliberately slow + salted -> offline brute force of a leaked DB is expensive.
    # (bcrypt only uses the first 72 bytes; we reject longer passwords at validation time.)
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds)).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


_DUMMY: dict[int, str] = {}


def dummy_hash(rounds: int) -> str:
    """A hash with the SAME cost as real ones, so login for an unknown email does the same bcrypt work.
    (A cost-4 dummy was ~250x cheaper than cost-12 real hashes, which re-opened the timing side channel --
    found in review.)"""
    if rounds not in _DUMMY:
        _DUMMY[rounds] = bcrypt.hashpw(b"timing-equaliser", bcrypt.gensalt(rounds)).decode()
    return _DUMMY[rounds]


def create_access_token(user_id: uuid.UUID, secret: str, ttl: int) -> str:
    now = int(time.time())
    return jwt.encode({"sub": str(user_id), "iat": now, "exp": now + ttl, "typ": "access", "jti": uuid.uuid4().hex},
                      secret, algorithm="HS256")


def decode_access_token(token: str, secret: str) -> uuid.UUID:
    claims = jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["exp", "sub", "typ"]})
    if claims["typ"] != "access":
        raise jwt.InvalidTokenError("wrong token type")
    return uuid.UUID(claims["sub"])


def opaque_token(prefix: str = "") -> str:
    return prefix + secrets.token_urlsafe(32)


def sha256(token: str) -> str:
    """Long random tokens don't need bcrypt (no dictionary to brute force); SHA-256 allows indexed lookup."""
    return hashlib.sha256(token.encode()).hexdigest()
