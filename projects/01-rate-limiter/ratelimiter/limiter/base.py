from __future__ import annotations

from typing import Protocol

from ..domain.models import Decision, Policy, PlanLimit


class RateLimiter(Protocol):
    """Every backend (Redis, in-memory, naive) implements the same contract."""

    async def check(self, key: str, policy: Policy, limit: PlanLimit, *, cost: int = 1,
                    now_ms: int | None = None) -> Decision: ...


class BackendUnavailable(Exception):
    """Raised when the shared store cannot be reached. The service layer decides fail-open/closed."""
