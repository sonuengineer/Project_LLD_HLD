# Testing -- Distributed Rate Limiter

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d      # Redis on 127.0.0.1:56379
../../.venv/Scripts/python -m pytest -q
```

Tests use Redis DB 15 (`RL_TEST_REDIS_URL` to override) and flush it before/after each test.
Failure tests use `redis://127.0.0.1:1` (nothing listens there) to simulate Redis being down.

## Suite (39 tests, all passing on 2026-11-16)

| File | What it proves |
|---|---|
| `test_algorithms.py` (15) | Each algorithm's semantics with an injected clock: limits, retry-after, refill, fractional tokens, cost > 1, boundary burst weakness of fixed window, no boundary burst for sliding log, server-time path, script cache flush, key TTLs |
| `test_distributed_correctness.py` (7) | 200 concurrent requests through 3 independent clients ("servers") -> exactly 50 allowed for all 5 algorithms; in-memory limiter allows 150 (3x); naive GET/SET on Redis overshoots |
| `test_api.py` (10) | Headers, 429 + Retry-After, per-IP isolation, plan limits via API keys, user vs API-key scope, 401/403, runtime policy override propagating between two app instances, invalid policy 422, spoofed header ignored, small pool waits instead of failing open |
| `test_failure_modes.py` (4) | Fail-open allows+degraded, fail-closed denies, HTTP 200 vs 503 per route, auth fails closed with 503 |
| `test_policy_validation.py` (4) | Pydantic rules for policies |

## Load tests (real runs, this machine)

Environment: Windows 11, Docker Desktop (12 vCPU VM shared with ~25 unrelated running containers),
3 single-worker uvicorn replicas, 1 Redis. Treat absolute numbers as this-machine-only.

### Correctness under load (Python generator inside the compose network)

`load_test.py --url http://nginx/api/resource --requests 3000 --concurrency 100` with an enterprise key,
started at a minute boundary:

```
status_codes={200: 300, 429: 2700}
served_by={'api1': 101, 'api2': 102, 'api3': 97}
```

Exactly 300 allowed (`ip_global` = 300/min binds because all requests share one source IP), spread
over all three instances. 0 server errors.

An earlier run that **crossed** a minute boundary allowed 315: that is the sliding counter correctly
admitting a share of the new window, not a bug (verified from server log timestamps).

### Throughput (k6 1.4.2, 64 VUs, 20s, inside compose network)

| Mode | req/s | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|
| baseline `/healthz` (no limiter) | 993 | 51.9 ms | 151.7 ms | 224.5 ms | 0 |
| allowed path (50k fake IPs, 2 Lua calls/req) | 500 | 97.4 ms | 335.5 ms | 427.4 ms | 0 |
| hot key (1 IP, mostly 429) | 722 | 79.4 ms | 196.1 ms | 271.2 ms | 0 |

Server-side handler time measured from logs during the baseline: p50 0.77 ms, p99 12.9 ms. The gap to
the client-side numbers is queueing in single-worker uvicorn processes on a contended VM.

### Lua micro-benchmark (`loadtest/bench_lua.py`, 20k checks, concurrency 50, host -> Docker port)

```
fixed_window       1167 checks/s   p50=28.70ms  p99=86.26ms
sliding_log        1593 checks/s   p50=22.66ms  p99=52.77ms
sliding_counter    1883 checks/s   p50=19.18ms  p99=45.57ms
token_bucket       2020 checks/s   p50=17.57ms  p99=43.69ms
leaky_bucket       2118 checks/s   p50=17.68ms  p99=36.14ms
```

These are bound by the single-threaded Python client and Docker Desktop's port proxy on Windows,
not by Redis. They are a lower bound, useful only for comparing algorithms relative to each other.

## Bugs found by load testing (and fixed)

1. **Default redis-py async pool raises `MaxConnectionsError` when exhausted** -> treated as "Redis
   down" -> silent fail-open during spikes. Fixed with `BlockingConnectionPool` (+ regression test).
2. **Synchronous stdout logging blocked the event loop** -> 50ms Redis timeouts fired although Redis
   was healthy -> 67 HTTP 500s and degraded decisions (357 allowed instead of 300). Fixed with
   `QueueHandler`/`QueueListener` logging in `bpcommon`, 250ms Redis timeout, and API-key auth mapped to 503.

## Reproduce

```bash
docker compose up -d --build && python seed.py http://127.0.0.1:58001
MSYS_NO_PATHCONV=1 docker run --rm -i --network p01-rate-limiter_default -e MODE=allowed grafana/k6:1.4.2 run - < loadtest/k6_benchmark.js
python loadtest/bench_lua.py
```
