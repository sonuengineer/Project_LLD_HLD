"""Request signing (a simplified AWS SigV4) and presigned URLs.

Signed request:
    Authorization: OBJ-HMAC-SHA256 Credential=<access_key_id>, Signature=<hex>
    x-obj-date: <unix seconds>
    x-obj-content-sha256: <hex sha256 of body> | UNSIGNED-PAYLOAD
    string_to_sign = METHOD \n RAW_PATH \n CANONICAL_QUERY \n DATE \n CONTENT_SHA256
    signature = hex(HMAC_SHA256(secret, string_to_sign))

Why sign method + path + query + date + body hash: the signature then authorises exactly ONE request;
changing any part (another key, DELETE instead of GET, a different body) invalidates it, and the date
bounds replay to the clock-skew window. The secret itself never travels over the network.

Presigned URL: the same idea moved into query parameters, with an EXPIRY instead of a date, so a
browser/third party can perform one specific operation without credentials until it expires.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from urllib.parse import parse_qsl, quote, urlencode

UNSIGNED = "UNSIGNED-PAYLOAD"
PRESIGN_PARAMS = {"X-Obj-Credential", "X-Obj-Expires", "X-Obj-Signature"}


def canonical_query(query: str, exclude: set[str] = frozenset()) -> str:
    pairs = sorted((k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k not in exclude)
    return "&".join(f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}" for k, v in pairs)


def string_to_sign(method: str, raw_path: str, query: str, date: str, content_sha256: str) -> str:
    return "\n".join([method.upper(), raw_path, canonical_query(query), date, content_sha256])


def sign(secret: str, msg: str) -> str:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


def quote_key(key: str) -> str:
    """Percent-encode an object key for a URL path. Path segments that are exactly '.' or '..' are
    encoded as %2E: otherwise HTTP clients normalise '/a/../b' to '/b' (RFC 3986 dot-segment removal)
    and a key like '../../etc/passwd' would silently address a different resource."""
    out = []
    for seg in key.split("/"):
        if seg in (".", ".."):
            out.append(seg.replace(".", "%2E"))
        else:
            out.append(quote(seg, safe="-_.~"))
    return "/".join(out)


def sign_headers(access_key: str, secret: str, method: str, raw_path: str, query: str = "",
                 body: bytes | None = None, now: int | None = None) -> dict[str, str]:
    """Client side: headers for a signed request (body=None -> UNSIGNED-PAYLOAD, for streams)."""
    date = str(now if now is not None else int(time.time()))
    sha = hashlib.sha256(body).hexdigest() if body is not None else UNSIGNED
    sig = sign(secret, string_to_sign(method, raw_path, query, date, sha))
    return {"Authorization": f"OBJ-HMAC-SHA256 Credential={access_key}, Signature={sig}",
            "x-obj-date": date, "x-obj-content-sha256": sha}


def presign(access_key: str, secret: str, method: str, raw_path: str, expires_at: int, extra_query: str = "") -> str:
    params = dict(parse_qsl(extra_query))
    params["X-Obj-Credential"] = access_key
    params["X-Obj-Expires"] = str(expires_at)
    q = urlencode(sorted(params.items()))
    msg = "\n".join([method.upper(), raw_path, canonical_query(q, {"X-Obj-Signature"}), "PRESIGNED", str(expires_at)])
    return f"{raw_path}?{q}&X-Obj-Signature={sign(secret, msg)}"


def presigned_string(method: str, raw_path: str, query: str, expires: str) -> str:
    return "\n".join([method.upper(), raw_path, canonical_query(query, {"X-Obj-Signature"}), "PRESIGNED", expires])


def parse_auth_header(value: str) -> tuple[str, str] | None:
    if not value.startswith("OBJ-HMAC-SHA256 "):
        return None
    parts = dict(p.strip().split("=", 1) for p in value[len("OBJ-HMAC-SHA256 "):].split(",") if "=" in p)
    if "Credential" not in parts or "Signature" not in parts:
        return None
    return parts["Credential"], parts["Signature"]
