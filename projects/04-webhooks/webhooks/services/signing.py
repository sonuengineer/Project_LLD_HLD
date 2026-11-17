"""Webhook signatures, following the Standard Webhooks spec (https://www.standardwebhooks.com).

Headers on every request:
    webhook-id         stable per EVENT (same across retries) -> receivers dedupe on it
    webhook-timestamp  unix seconds of THIS attempt           -> receivers reject stale requests
    webhook-signature  "v1,<base64 hmac>" ... space separated -> one per active secret (rotation)

signed_content = f"{webhook_id}.{timestamp}.{raw_body}"
signature      = base64(HMAC_SHA256(key=base64decode(secret without 'whsec_'), signed_content))

Why sign id + timestamp too: signing only the body would let an attacker who captured one
request replay it forever. With the timestamp inside the MAC, they can't change it, and the
receiver rejects anything older than its tolerance window (5 minutes here).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets as _secrets
import time

PREFIX = "whsec_"
DEFAULT_TOLERANCE_SECONDS = 300


class VerificationError(Exception):
    pass


def generate_secret() -> str:
    return PREFIX + base64.b64encode(_secrets.token_bytes(32)).decode()


def _key(secret: str) -> bytes:
    return base64.b64decode(secret.removeprefix(PREFIX))


def sign(secret: str, msg_id: str, timestamp: int, body: bytes) -> str:
    signed = f"{msg_id}.{timestamp}.".encode() + body
    return "v1," + base64.b64encode(hmac.new(_key(secret), signed, hashlib.sha256).digest()).decode()


def signature_header(secrets: list[str], msg_id: str, timestamp: int, body: bytes) -> str:
    return " ".join(sign(s, msg_id, timestamp, body) for s in secrets)


def verify(secrets: list[str], headers: dict[str, str], body: bytes, *,
           tolerance: int = DEFAULT_TOLERANCE_SECONDS, now: int | None = None) -> None:
    """Receiver-side verification. Raises VerificationError. Accepts if ANY of the receiver's
    secrets matches ANY signature in the header (so both sides can rotate independently)."""
    h = {k.lower(): v for k, v in headers.items()}
    msg_id, ts, sig_header = h.get("webhook-id"), h.get("webhook-timestamp"), h.get("webhook-signature")
    if not (msg_id and ts and sig_header):
        raise VerificationError("missing webhook headers")
    try:
        timestamp = int(ts)
    except ValueError:
        raise VerificationError("invalid timestamp") from None
    now = int(time.time()) if now is None else now
    if abs(now - timestamp) > tolerance:
        raise VerificationError("timestamp outside tolerance (possible replay)")
    provided = [p.split(",", 1)[1] for p in sig_header.split() if p.startswith("v1,")]
    for secret in secrets:
        expected = sign(secret, msg_id, timestamp, body).split(",", 1)[1]
        # compare_digest: constant time, so response timing can't reveal how many bytes matched.
        if any(hmac.compare_digest(expected, p) for p in provided):
            return
    raise VerificationError("no matching signature")
