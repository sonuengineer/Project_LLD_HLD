from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from bpcommon.errors import Forbidden

from .plans import Plan, get_plan
from .rbac import P


@dataclass
class Principal:
    """Who is calling, in which tenant, with which permissions. Built once per request."""
    tenant_id: uuid.UUID
    tenant_slug: str
    plan: Plan
    permissions: frozenset[P]
    role: str | None = None                 # None for API keys
    user_id: uuid.UUID | None = None
    api_key_id: uuid.UUID | None = None
    ip: str | None = None
    request_id: str | None = None
    extra: dict = field(default_factory=dict)

    def require(self, perm: P) -> None:
        if perm not in self.permissions:
            raise Forbidden(f"missing permission {perm.value}", details={"permission": perm.value})

    def require_feature(self, feature: str) -> None:
        from ..services.errors import FeatureNotInPlan
        if feature not in self.plan.features:
            raise FeatureNotInPlan(f"feature '{feature}' is not included in plan '{self.plan.name}'",
                                   details={"feature": feature, "plan": self.plan.name})


def plan_for(name: str) -> Plan:
    return get_plan(name)
