"""End-to-end HTTP tests through the real FastAPI app and real Redis."""
import asyncio
import contextlib

import httpx
import pytest
from redis.asyncio import Redis

from ratelimiter.config import Settings
from ratelimiter.main import create_app

from .conftest import REDIS_URL

ADMIN = {"X-Admin-Token": "test-admin"}


@contextlib.asynccontextmanager
async def client_for(redis, **overrides):
    settings = Settings(redis_url=REDIS_URL, admin_token="test-admin", policy_cache_ttl_seconds=0,
                        trust_forwarded_for=True, log_json=False, log_level="WARNING", **overrides)
    app = create_app(settings, redis=redis)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            yield c


async def test_headers_on_success(redis):
    async with client_for(redis) as c:
        r = await c.get("/api/resource", headers={"X-Real-IP": "1.1.1.1"})
    assert r.status_code == 200
    assert r.headers["RateLimit-Limit"] == "20"            # anonymous plan of user_plan is the binding policy
    assert r.headers["RateLimit-Remaining"] == "19"
    assert "X-RateLimit-Reset" in r.headers and "x-request-id" in r.headers


async def test_429_with_retry_after_for_anonymous(redis):
    async with client_for(redis) as c:
        codes = [(await c.get("/api/resource", headers={"X-Real-IP": "2.2.2.2"})).status_code for _ in range(21)]
        last = await c.get("/api/resource", headers={"X-Real-IP": "2.2.2.2"})
        other_ip = await c.get("/api/resource", headers={"X-Real-IP": "3.3.3.3"})
    assert codes[:20] == [200] * 20 and codes[20] == 429
    assert last.status_code == 429
    assert int(last.headers["Retry-After"]) >= 1
    body = last.json()["error"]
    assert body["code"] == "rate_limited" and body["details"]["policy"] == "user_plan"
    assert other_ip.status_code == 200  # per-IP isolation


async def test_plan_limits_via_api_key(redis):
    async with client_for(redis) as c:
        pro = (await c.post("/admin/api-keys", json={"user_id": "alice", "plan": "pro"}, headers=ADMIN)).json()
        r = await c.get("/api/resource", headers={"X-API-Key": pro["api_key"], "X-Real-IP": "4.4.4.4"})
    assert r.status_code == 200
    assert r.json()["plan"] == "pro"
    # binding = smallest remaining: ip_global (300) vs user_plan pro (600) -> ip_global
    assert r.headers["RateLimit-Limit"] == "300"


async def test_user_quota_shared_across_keys_but_api_key_scope_is_per_key(redis):
    async with client_for(redis) as c:
        k1 = (await c.post("/admin/api-keys", json={"user_id": "bob", "plan": "free"}, headers=ADMIN)).json()
        k2 = (await c.post("/admin/api-keys", json={"user_id": "bob", "plan": "free"}, headers=ADMIN)).json()
        # search_burst: token bucket capacity 5 per API KEY for free plan
        s1 = [(await c.get("/api/search", headers={"X-API-Key": k1["api_key"]})).status_code for _ in range(6)]
        s2 = (await c.get("/api/search", headers={"X-API-Key": k2["api_key"]})).status_code
    assert s1 == [200] * 5 + [429]
    assert s2 == 200  # different key -> its own bucket


async def test_invalid_api_key_is_401(redis):
    async with client_for(redis) as c:
        r = await c.get("/api/resource", headers={"X-API-Key": "nope"})
    assert r.status_code == 401


async def test_admin_requires_token(redis):
    async with client_for(redis) as c:
        assert (await c.get("/admin/policies")).status_code == 403
        assert (await c.get("/admin/policies", headers={"X-Admin-Token": "wrong"})).status_code == 403
        assert (await c.get("/admin/policies", headers=ADMIN)).status_code == 200


async def test_policy_override_propagates_to_other_instance(redis):
    """Instance A updates a policy; instance B (same Redis) sees it on next cache refresh."""
    async with client_for(redis) as a, client_for(redis) as b:
        policy = (await a.get("/admin/policies", headers=ADMIN)).json()["policies"]
        user_plan = next(p for p in policy if p["name"] == "user_plan")
        user_plan["plans"]["anonymous"]["limit"] = 2
        assert (await a.put("/admin/policies/user_plan", json=user_plan, headers=ADMIN)).status_code == 200
        codes = [(await b.get("/api/resource", headers={"X-Real-IP": "5.5.5.5"})).status_code for _ in range(3)]
        assert codes == [200, 200, 429]
        await a.delete("/admin/policies/user_plan/override", headers=ADMIN)
        r = await b.get("/api/resource", headers={"X-Real-IP": "6.6.6.6"})
        assert r.headers["RateLimit-Limit"] == "20"


async def test_invalid_policy_rejected(redis):
    async with client_for(redis) as c:
        bad = {"name": "search_burst", "algorithm": "token_bucket", "scope": "api_key",
               "plans": {}, "default": {"limit": 5, "window_seconds": 1}}  # token bucket needs rate
        r = await c.put("/admin/policies/search_burst", json=bad, headers=ADMIN)
    assert r.status_code == 422


async def test_untrusted_forwarded_header_is_ignored(redis):
    """With trust_forwarded_for=False a client can't dodge per-IP limits by spoofing X-Real-IP."""
    settings = Settings(redis_url=REDIS_URL, admin_token="x", policy_cache_ttl_seconds=0,
                        trust_forwarded_for=False, log_json=False, log_level="WARNING")
    app = create_app(settings, redis=redis)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            codes = [(await c.get("/api/resource", headers={"X-Real-IP": f"9.9.9.{i}"})).status_code
                     for i in range(21)]
    assert codes[-1] == 429


async def test_small_pool_waits_instead_of_failing_open(redis):
    """100 concurrent requests through a 5-connection pool: none may be 'degraded'.
    Regression test for the default (non-blocking) pool raising MaxConnectionsError."""
    settings = Settings(redis_url=REDIS_URL, admin_token="x", policy_cache_ttl_seconds=0, log_json=False,
                        log_level="WARNING", redis_max_connections=5, redis_pool_timeout=5,
                        redis_socket_timeout=2)
    app = create_app(settings)  # app builds its own BlockingConnectionPool
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            rs = await asyncio.gather(*[c.get("/api/resource") for _ in range(100)])
    assert not any(r.headers.get("X-RateLimit-Status") == "degraded" for r in rs)
    assert sum(r.status_code == 200 for r in rs) == 20  # anonymous limit, exact
