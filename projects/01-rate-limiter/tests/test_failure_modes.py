"""What happens when Redis is DOWN. We point at a port where nothing listens."""
import httpx
from redis.asyncio import Redis

from ratelimiter.config import Settings
from ratelimiter.domain.models import Algorithm, FailMode, Identity
from ratelimiter.limiter.redis_limiter import RedisRateLimiter
from ratelimiter.main import create_app
from ratelimiter.services.rate_limit_service import RateLimitService

from .conftest import make_policy

DEAD = "redis://127.0.0.1:1/0"


def dead_redis() -> Redis:
    return Redis.from_url(DEAD, socket_connect_timeout=0.2, socket_timeout=0.2)


async def test_fail_open_allows_and_marks_degraded():
    r = dead_redis()
    svc = RateLimitService(RedisRateLimiter(r), policies=None)
    p = make_policy(Algorithm.TOKEN_BUCKET, 5, rate=1, fail_mode=FailMode.OPEN)
    d = await svc.check_one(Identity(ip="1.2.3.4"), p)
    await r.aclose()
    assert d.allowed and d.degraded


async def test_fail_closed_denies():
    r = dead_redis()
    svc = RateLimitService(RedisRateLimiter(r), policies=None)
    p = make_policy(Algorithm.SLIDING_LOG, 5, window=60, fail_mode=FailMode.CLOSED)
    d = await svc.check_one(Identity(ip="1.2.3.4"), p)
    await r.aclose()
    assert not d.allowed and d.degraded


async def test_http_fail_open_and_fail_closed_routes():
    r = dead_redis()
    settings = Settings(redis_url=DEAD, admin_token="x", log_json=False, log_level="CRITICAL")
    app = create_app(settings, redis=r)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            open_route = await c.get("/api/resource")   # policies fail open
            closed_route = await c.post("/api/login")   # login_bruteforce fails closed
            stats = await c.get("/admin/stats", headers={"X-Admin-Token": "x"})
    await r.aclose()
    assert open_route.status_code == 200
    assert open_route.headers["X-RateLimit-Status"] == "degraded"
    assert closed_route.status_code == 503
    assert closed_route.headers["Retry-After"] == "1"
    assert stats.json()["backend_errors"].get("login_bruteforce", 0) >= 1


async def test_api_key_auth_fails_closed_with_503_not_500():
    r = dead_redis()
    settings = Settings(redis_url=DEAD, admin_token="x", log_json=False, log_level="CRITICAL")
    app = create_app(settings, redis=r)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            resp = await c.get("/api/resource", headers={"X-API-Key": "rlk_anything"})
    await r.aclose()
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "service_unavailable"
