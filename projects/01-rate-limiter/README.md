# Project 1 -- Distributed Rate Limiter

A Redis-backed rate limiting service with **five algorithms implemented as atomic Lua scripts**,
subscription-plan limits, per-IP / per-user / per-API-key scopes, standard rate limit headers,
configurable fail-open / fail-closed behaviour, Prometheus metrics, and a 3-replica horizontal
scaling demo behind Nginx.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Fixed window | `ratelimiter/limiter/lua/fixed_window.lua` | `tests/test_algorithms.py::TestFixedWindow` |
| Sliding window log (exact) | `lua/sliding_log.lua` | `TestSlidingLog` |
| Sliding window counter (approx, O(1)) | `lua/sliding_counter.lua` | `TestSlidingCounter` |
| Token bucket | `lua/token_bucket.lua` | `TestTokenBucket` |
| Leaky bucket (meter variant) | `lua/leaky_bucket.lua` | `TestLeakyBucket` |
| Atomicity under concurrency (200 parallel requests, 3 "servers", exactly 50 allowed) | `limiter/redis_limiter.py` | `tests/test_distributed_correctness.py` |
| In-memory limiter overshoot demo (3x the limit) | `limiter/memory_limiter.py` | same file |
| Non-atomic GET/SET race demo | `limiter/naive_redis_limiter.py` | same file |
| Per-IP / per-user / per-API-key scopes | `domain/models.py`, `services/rate_limit_service.py` | `tests/test_api.py` |
| Plans: anonymous / free / pro / enterprise | `policies.json` | `test_plan_limits_via_api_key` |
| Policies configurable at runtime, shared via Redis | `services/policy_store.py` | `test_policy_override_propagates_to_other_instance` |
| `RateLimit-*`, `X-RateLimit-*`, `Retry-After` headers | `services/rate_limit_service.py` | `test_429_with_retry_after_for_anonymous` |
| Fail-open vs fail-closed per policy | `services/rate_limit_service.py` | `tests/test_failure_modes.py` |
| API keys stored hashed, auth fails closed (503) | `services/api_keys.py` | `test_api_key_auth_fails_closed_with_503_not_500` |
| Prometheus metrics + JSON stats + dashboard | `services/metrics.py`, `/metrics`, `/admin/stats`, `/dashboard` | `test_http_fail_open_and_fail_closed_routes` |
| Load testing (Python + k6) | `loadtest/` | results in `TESTING.md` |

## Quick start (local, no Docker for the app)

```bash
# from repo root: shared Postgres/Redis (only Redis is used here)
docker compose -f infra/docker-compose.yml up -d
python -m venv .venv && .venv/Scripts/pip install -e shared -r projects/01-rate-limiter/requirements-dev.txt

cd projects/01-rate-limiter
../../.venv/Scripts/uvicorn ratelimiter.main:app --port 8001
../../.venv/Scripts/python seed.py http://127.0.0.1:8001     # prints demo API keys per plan
curl -i http://127.0.0.1:8001/api/resource
../../.venv/Scripts/python -m pytest -q                      # 39 tests
```

Open `http://127.0.0.1:8001/docs` (OpenAPI) and `http://127.0.0.1:8001/dashboard`.

## Horizontal scaling demo (3 replicas + Nginx + Redis)

```bash
cd projects/01-rate-limiter
docker compose up -d --build
python seed.py http://127.0.0.1:58001
curl -i http://127.0.0.1:58001/api/resource     # responses come from api1/api2/api3, limit still exact
docker compose down
```

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- Multiple policies on one route are checked sequentially, not in one atomic script (see TRADEOFFS.md #4).
- No Redis Cluster / Sentinel setup is included. Keys use `{hash tags}`, but `fixed_window.lua` and
  `sliding_counter.lua` derive per-window keys inside the script instead of declaring them in `KEYS`;
  that works on a single Redis but must be changed (pass the window keys in) before running on Redis Cluster.
- Leaky bucket is the "meter" variant (rejects), not the "queue" variant (delays).
- `/admin/stats` is per instance; cluster-wide numbers need Prometheus aggregation.
- The API key cache means revocation takes up to 30s per instance.
