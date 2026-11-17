"""Domain types for rate limiting. Pure data, no I/O."""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


class Algorithm(StrEnum):
    FIXED_WINDOW = "fixed_window"
    SLIDING_LOG = "sliding_log"
    SLIDING_COUNTER = "sliding_counter"
    TOKEN_BUCKET = "token_bucket"
    LEAKY_BUCKET = "leaky_bucket"


class Scope(StrEnum):
    """What identity the counter is keyed on."""
    IP = "ip"
    USER = "user"
    API_KEY = "api_key"


class FailMode(StrEnum):
    OPEN = "open"      # Redis down -> allow request (availability over protection)
    CLOSED = "closed"  # Redis down -> reject with 503 (protection over availability)


class Plan(StrEnum):
    ANONYMOUS = "anonymous"
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"


class PlanLimit(BaseModel):
    """Numbers for one plan. Meaning depends on the algorithm:
    - window algorithms: `limit` requests per `window_seconds`
    - token bucket: `limit` = capacity (burst), `rate_per_second` = refill
    - leaky bucket: `limit` = capacity, `rate_per_second` = leak rate
    """
    limit: int = Field(gt=0)
    window_seconds: float | None = Field(default=None, gt=0)
    rate_per_second: float | None = Field(default=None, gt=0)


class Policy(BaseModel):
    name: str = Field(pattern=r"^[a-z0-9_\-]{1,64}$")
    description: str = ""
    algorithm: Algorithm
    scope: Scope
    fail_mode: FailMode = FailMode.OPEN
    # Limits per plan. A plan missing here falls back to `default`.
    plans: dict[Plan, PlanLimit]
    default: PlanLimit

    @model_validator(mode="after")
    def _check_params(self) -> "Policy":
        windowed = self.algorithm in {Algorithm.FIXED_WINDOW, Algorithm.SLIDING_LOG, Algorithm.SLIDING_COUNTER}
        for label, lim in [("default", self.default), *[(p.value, l) for p, l in self.plans.items()]]:
            if windowed and lim.window_seconds is None:
                raise ValueError(f"{self.algorithm} needs window_seconds (plan {label})")
            if not windowed and lim.rate_per_second is None:
                raise ValueError(f"{self.algorithm} needs rate_per_second (plan {label})")
        return self

    def limit_for(self, plan: Plan) -> PlanLimit:
        return self.plans.get(plan, self.default)


@dataclass(frozen=True, slots=True)
class Decision:
    allowed: bool
    limit: int
    remaining: int
    retry_after_ms: int
    reset_ms: int
    policy: str
    algorithm: Algorithm
    degraded: bool = False  # True when we failed open because the backend was unavailable


@dataclass(frozen=True, slots=True)
class Identity:
    ip: str
    user_id: str | None = None
    api_key_id: str | None = None
    plan: Plan = Plan.ANONYMOUS

    def key_for(self, scope: Scope) -> str | None:
        return {Scope.IP: self.ip, Scope.USER: self.user_id, Scope.API_KEY: self.api_key_id}[scope]
