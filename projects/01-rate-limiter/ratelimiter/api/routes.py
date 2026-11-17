from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from bpcommon.errors import NotFound

from ..domain.models import Identity, Plan, Policy
from .deps import rate_limited, require_admin

public = APIRouter(prefix="/api", tags=["demo api (rate limited)"])
admin = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@public.get("/resource")
async def get_resource(request: Request, identity: Identity = Depends(rate_limited("default"))):
    return {"ok": True, "served_by": request.app.state.settings.instance_name,
            "user_id": identity.user_id, "plan": identity.plan}


@public.get("/search")
async def search(q: str = "", identity: Identity = Depends(rate_limited("search"))):
    return {"ok": True, "q": q, "results": []}


@public.post("/login")
async def login(_: Identity = Depends(rate_limited("login"))):
    # Demo only: real auth lives in Project 6. Here we only show the limiter on a sensitive route.
    return {"ok": False, "reason": "demo endpoint; credentials are not checked"}


@public.post("/reports")
async def create_report(identity: Identity = Depends(rate_limited("reports"))):
    return {"ok": True, "report": "queued", "user_id": identity.user_id}


class CreateKey(BaseModel):
    user_id: str
    plan: Plan = Plan.FREE


@admin.post("/api-keys", status_code=201)
async def create_api_key(body: CreateKey, request: Request):
    raw, record = await request.app.state.api_keys.create(body.user_id, body.plan)
    return {"api_key": raw, "key_id": record.key_id, "user_id": record.user_id, "plan": record.plan,
            "note": "Store this key now; only its hash is kept server-side."}


@admin.get("/policies")
async def list_policies(request: Request):
    store = request.app.state.policy_store
    return {"route_groups": store.route_groups,
            "policies": [p.model_dump(mode="json") for p in (await store.get_all()).values()]}


@admin.put("/policies/{name}")
async def update_policy(name: str, policy: Policy, request: Request):
    if policy.name != name:
        from bpcommon.errors import Unprocessable
        raise Unprocessable("Body name must match URL name")
    try:
        await request.app.state.policy_store.upsert(policy)
    except KeyError:
        raise NotFound(f"Unknown policy '{name}'")
    return policy.model_dump(mode="json")


@admin.delete("/policies/{name}/override", status_code=204)
async def reset_policy(name: str, request: Request):
    await request.app.state.policy_store.reset(name)


@admin.get("/stats")
async def stats():
    """Per-instance counters from the Prometheus registry. Cluster-wide totals come from
    Prometheus scraping every instance and summing (sum by (policy,result))."""
    from prometheus_client import REGISTRY

    rows: dict[tuple[str, str], float] = {}
    errors: dict[str, float] = {}
    for metric in REGISTRY.collect():
        if metric.name == "rate_limit_decisions":
            for s in metric.samples:
                if s.name.endswith("_total"):
                    rows[(s.labels["policy"], s.labels["result"])] = s.value
        elif metric.name == "rate_limit_backend_errors":
            for s in metric.samples:
                if s.name.endswith("_total"):
                    errors[s.labels["policy"]] = s.value
    policies: dict[str, dict[str, float]] = {}
    for (policy, result), value in rows.items():
        policies.setdefault(policy, {})[result] = value
    return {"policies": policies, "backend_errors": errors}
