# Architecture -- Distributed Rate Limiter

## Layers

```
ratelimiter/
  main.py                    app factory, wiring (composition root)
  config.py                  env-based settings (RL_*)
  policies.json              default policies + route groups
  api/deps.py                identity resolution, rate_limited() dependency, admin auth
  api/routes.py              demo endpoints + admin endpoints
  services/rate_limit_service.py   orchestration: identity -> policies -> decisions -> headers
  services/policy_store.py   defaults + Redis overrides + local TTL cache
  services/api_keys.py       hashed API keys, cached lookup, fail-closed auth
  services/metrics.py        Prometheus counters/histograms
  domain/models.py           Policy, PlanLimit, Decision, Identity (pure, no I/O)
  limiter/base.py            RateLimiter protocol + BackendUnavailable
  limiter/redis_limiter.py   production backend (Lua scripts)
  limiter/lua/*.lua          one atomic script per algorithm
  limiter/memory_limiter.py  teaching contrast (single-process only)
  limiter/naive_redis_limiter.py  teaching contrast (race condition)
```

Dependency direction: `api -> services -> limiter -> domain`. The domain layer imports nothing
from the others, so policy validation can be unit tested without Redis.

## Component diagram

```mermaid
flowchart LR
  C[Clients] --> N[Nginx LB]
  N --> A1[API instance 1]
  N --> A2[API instance 2]
  N --> A3[API instance 3]
  subgraph Instance
    D[rate_limited dependency] --> S[RateLimitService]
    S --> PS[PolicyStore<br/>local cache 5s]
    S --> L[RedisRateLimiter]
    D --> K[ApiKeyStore<br/>local cache 30s]
  end
  A1 & A2 & A3 --> R[(Redis<br/>counters, buckets,<br/>policy overrides,<br/>hashed API keys)]
  P[Prometheus] -. scrape /metrics .-> A1 & A2 & A3
```

## Request lifecycle

```mermaid
sequenceDiagram
  participant C as Client
  participant API as FastAPI route
  participant ID as resolve_identity
  participant RS as RateLimitService
  participant PS as PolicyStore
  participant R as Redis (Lua)
  C->>API: GET /api/search (X-API-Key)
  API->>ID: hash key, lookup (cache or Redis)
  ID-->>API: Identity(ip, user_id, key_id, plan)
  API->>RS: evaluate(identity, "search")
  RS->>PS: policies for route group (cached)
  loop each policy in order
    RS->>R: EVALSHA script(key, limit, window/rate, now, cost)
    R-->>RS: {allowed, remaining, retry_ms, reset_ms}
    alt denied
      RS-->>API: CombinedDecision(denied)
      API-->>C: 429 + Retry-After + RateLimit-* headers
    end
  end
  RS-->>API: CombinedDecision(allowed)
  API-->>C: 200 + RateLimit-* headers (binding = fewest remaining)
```

## Failure and fallback flow

```mermaid
flowchart TD
  A[Limiter check] --> B{Redis reachable<br/>within 250ms?}
  B -- yes --> C[Lua decision]
  B -- no --> D[BackendUnavailable]
  D --> E{policy.fail_mode}
  E -- open --> F[Allow, X-RateLimit-Status: degraded,<br/>metric degraded_allow]
  E -- closed --> G[503 + Retry-After: 1,<br/>metric degraded_deny]
  H[API key lookup] --> I{Redis error?}
  I -- yes, not cached --> G
  I -- cached --> J[Use cached identity]
```

## Key design decisions

1. **Lua scripts, not MULTI/EXEC or WATCH.** A script reads and writes in one atomic step on the
   server, with one network round-trip. WATCH-based optimistic locking needs retries under contention.
2. **Redis server time by default.** `redis.call('TIME')` gives every app instance the same clock,
   so clock skew between servers can't make one instance think a window has ended early. Tests pass
   `now_ms` explicitly for determinism.
3. **Dependency, not global middleware.** `Depends(rate_limited("search"))` lets each route pick a
   policy group and keeps limits visible next to the route.
4. **Policies cached locally, overrides in Redis.** No extra Redis call per request for config;
   changes reach all instances within `RL_POLICY_CACHE_TTL_SECONDS`.
5. **Protocol-based limiter backends.** Redis, in-memory and naive implementations share one
   interface, which is what makes the "why in-memory fails" tests possible.
