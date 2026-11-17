"""SSRF guard: a webhook URL is attacker-controlled input that makes OUR servers send requests.

Without a guard, a customer registers http://169.254.169.254/latest/meta-data/ (cloud metadata ->
credentials) or http://localhost:6379/ and our dispatcher attacks our own network.

Checks happen at SEND time, after DNS resolution: validating only at registration is defeated by
DNS rebinding (hostname resolves to a public IP when registered, to 10.0.0.5 later).
Redirects are never followed (a public URL could redirect to an internal one).
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit


class BlockedDestination(Exception):
    pass


def validate_url_syntax(url: str, *, allow_private: bool) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http"):
        raise BlockedDestination("only http(s) URLs are allowed")
    if parts.scheme == "http" and not allow_private:
        raise BlockedDestination("plain http is only allowed in development")
    if not parts.hostname:
        raise BlockedDestination("URL has no host")
    if parts.username or parts.password:
        raise BlockedDestination("credentials in URL are not allowed")


def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


async def assert_public_destination(url: str, *, allow_private: bool) -> str | None:
    """Returns the validated IP to connect to (None in allow_private/dev mode). The caller MUST connect to
    this IP: resolving the name again at connect time would reopen a DNS-rebinding window (TOCTOU)."""
    validate_url_syntax(url, allow_private=allow_private)
    if allow_private:
        return None
    host = urlsplit(url).hostname
    port = urlsplit(url).port or (443 if url.startswith("https") else 80)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise BlockedDestination(f"DNS resolution failed: {exc}") from None
    bad = sorted({i[4][0] for i in infos if not _is_public(i[4][0])})
    if bad:
        raise BlockedDestination(f"destination resolves to non-public address(es): {', '.join(bad)}")
    return infos[0][4][0]
