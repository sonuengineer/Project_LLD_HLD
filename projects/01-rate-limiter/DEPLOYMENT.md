# Deployment -- Distributed Rate Limiter

## Container

`Dockerfile` (build context = repo root): `python:3.12-slim`, pinned requirements, shared `bpcommon`
installed, runs as non-root uid 10001, `uvicorn ratelimiter.main:app`.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `RL_REDIS_URL` | `redis://127.0.0.1:56379/0` | use `rediss://` + ACL user in production |
| `RL_REDIS_SOCKET_TIMEOUT` | 0.25 | seconds |
| `RL_REDIS_MAX_CONNECTIONS` | 200 | per process |
| `RL_REDIS_POOL_TIMEOUT` | 0.1 | wait for a free connection |
| `RL_POLICY_CACHE_TTL_SECONDS` | 5 | config propagation delay |
| `RL_API_KEY_CACHE_TTL_SECONDS` | 30 | revocation delay |
| `RL_ADMIN_TOKEN` | placeholder | **must** be set |
| `RL_TRUST_FORWARDED_FOR` | false | true only behind a trusted proxy |
| `RL_INSTANCE_NAME` | rl-local | shows up in responses |
| `RL_LOG_LEVEL` / `RL_LOG_JSON` | INFO / true | |

## Production checklist

1. Redis: dedicated instance (or Cluster), AUTH + TLS, `maxmemory` + eviction policy, Sentinel or a
   managed service for failover. Persistence optional (soft state).
2. Run 2+ app replicas behind a load balancer that sets `X-Real-IP`; enable `RL_TRUST_FORWARDED_FOR`
   only there; never expose app ports directly.
3. Multiple uvicorn workers per container (`--workers N`) or more replicas; each worker has its own pool.
4. Scrape `/metrics`; alert on backend errors and denial ratio (see FAILURE_SCENARIOS.md).
5. Health checks on `/healthz`; readiness could additionally PING Redis.
6. Keep `/admin/*` off the public internet (internal network or VPN) in addition to the token.

## Local multi-replica deployment

```bash
docker compose up -d --build     # nginx on 127.0.0.1:58001
docker compose ps
docker compose down
```
