"""Subscription plans: limits (entitlements), features, rate limits, quotas. Code, not DB rows:
plan changes are deploys reviewed like code; per-tenant overrides would go in a table."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Plan:
    name: str
    max_projects: int | None          # None = unlimited
    max_members: int | None
    features: frozenset[str]
    requests_per_second: float        # tenant-wide rate limit (token bucket refill)
    burst: int
    monthly_api_calls: int | None     # usage quota


PLANS: dict[str, Plan] = {
    "free": Plan("free", 3, 3, frozenset({"projects"}), 5, 10, 10_000),
    "pro": Plan("pro", 50, 25, frozenset({"projects", "reports", "audit_export"}), 50, 100, 1_000_000),
    "enterprise": Plan("enterprise", None, None, frozenset({"projects", "reports", "audit_export", "sso"}),
                       200, 400, None),
}


def get_plan(name: str) -> Plan:
    return PLANS.get(name, PLANS["free"])
