"""Orchestrates: identity -> applicable policies -> limiter checks -> one combined decision."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from bpcommon.errors import ServiceUnavailable, TooManyRequests

from ..domain.models import Decision, FailMode, Identity, Policy, Scope
from ..limiter.base import BackendUnavailable, RateLimiter
from .metrics import BACKEND_ERRORS, CHECK_LATENCY, DECISIONS
from .policy_store import PolicyStore

log = logging.getLogger(__name__)


@dataclass
class CombinedDecision:
    allowed: bool
    decisions: list[Decision]

    @property
    def binding(self) -> Decision | None:
        """The decision clients should see in headers: a denial if any, else the one with fewest remaining."""
        if not self.decisions:
            return None
        denied = [d for d in self.decisions if not d.allowed]
        if denied:
            return max(denied, key=lambda d: d.retry_after_ms)
        return min(self.decisions, key=lambda d: d.remaining)


class RateLimitService:
    def __init__(self, limiter: RateLimiter, policies: PolicyStore):
        self._limiter = limiter
        self._policies = policies

    @staticmethod
    def _identity_key(identity: Identity, policy: Policy) -> str:
        key = identity.key_for(policy.scope)
        if key is None:
            # Anonymous caller hitting a user/api_key scoped policy: fall back to IP so
            # anonymous traffic is still limited (otherwise "no key" = "no limit").
            key = f"anon-ip:{identity.ip}"
        else:
            key = f"{policy.scope.value}:{key}"
        return key

    async def check_one(self, identity: Identity, policy: Policy, *, cost: int = 1,
                        now_ms: int | None = None) -> Decision:
        limit = policy.limit_for(identity.plan)
        start = time.perf_counter()
        try:
            decision = await self._limiter.check(self._identity_key(identity, policy), policy, limit,
                                                 cost=cost, now_ms=now_ms)
        except BackendUnavailable as exc:
            BACKEND_ERRORS.labels(policy.name).inc()
            log.warning("rate_limit_backend_unavailable",
                        extra={"policy": policy.name, "fail_mode": policy.fail_mode.value, "error": str(exc)})
            allowed = policy.fail_mode is FailMode.OPEN
            DECISIONS.labels(policy.name, policy.algorithm.value,
                             "degraded_allow" if allowed else "degraded_deny").inc()
            return Decision(allowed=allowed, limit=limit.limit, remaining=limit.limit if allowed else 0,
                            retry_after_ms=0 if allowed else 1000, reset_ms=0, policy=policy.name,
                            algorithm=policy.algorithm, degraded=True)
        finally:
            CHECK_LATENCY.labels(policy.algorithm.value).observe(time.perf_counter() - start)
        DECISIONS.labels(policy.name, policy.algorithm.value, "allowed" if decision.allowed else "denied").inc()
        return decision

    async def evaluate(self, identity: Identity, route_group: str, *, cost: int = 1,
                       now_ms: int | None = None) -> CombinedDecision:
        """Check every policy for the route group. Stops at the first denial.

        Trade-off (documented in TRADEOFFS.md): policies are checked sequentially, so a
        request allowed by policy 1 but denied by policy 2 has still consumed one unit of
        policy 1. Making the whole set atomic would need one Lua script over many keys.
        Ordering cheap/broad policies first keeps this effect small.
        """
        decisions: list[Decision] = []
        for policy in await self._policies.for_route_group(route_group):
            d = await self.check_one(identity, policy, cost=cost, now_ms=now_ms)
            decisions.append(d)
            if not d.allowed:
                return CombinedDecision(False, decisions)
        return CombinedDecision(True, decisions)


def rate_limit_headers(decision: Decision | None) -> dict[str, str]:
    if decision is None:
        return {}
    reset_s = max((decision.reset_ms + 999) // 1000, 0)
    headers = {
        # IETF draft "RateLimit Fields for HTTP" style headers ...
        "RateLimit-Limit": str(decision.limit),
        "RateLimit-Remaining": str(max(decision.remaining, 0)),
        "RateLimit-Reset": str(reset_s),
        "RateLimit-Policy": f"{decision.policy};alg={decision.algorithm.value}",
        # ... and the widely used legacy X- headers.
        "X-RateLimit-Limit": str(decision.limit),
        "X-RateLimit-Remaining": str(max(decision.remaining, 0)),
        "X-RateLimit-Reset": str(reset_s),
    }
    if decision.degraded:
        headers["X-RateLimit-Status"] = "degraded"
    return headers


def raise_if_denied(combined: CombinedDecision) -> dict[str, str]:
    d = combined.binding
    headers = rate_limit_headers(d)
    if combined.allowed:
        return headers
    if d.degraded:  # fail-closed policy and backend is down
        raise ServiceUnavailable("Rate limiter unavailable; request rejected (fail-closed policy)",
                                 details={"policy": d.policy}, headers={**headers, "Retry-After": "1"})
    retry_s = max((d.retry_after_ms + 999) // 1000, 1)  # Retry-After is whole seconds, never 0
    headers["Retry-After"] = str(retry_s)
    raise TooManyRequests(f"Rate limit exceeded for policy '{d.policy}'",
                          details={"policy": d.policy, "algorithm": d.algorithm.value,
                                   "retry_after_ms": d.retry_after_ms}, headers=headers)
