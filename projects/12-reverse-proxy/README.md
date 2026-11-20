# H11 -- Reverse Proxy + Load Balancer (TypeScript, zero runtime dependencies)

A hand-written HTTP reverse proxy on Node's built-in `http` module. Built in stages so every claim here is backed by
code and tests that exist today.

## Status

| Stage | What | Status |
|---|---|---|
| 1 | Reverse proxy to ONE upstream: streaming, headers, errors, timeouts, loop detection, graceful shutdown | DONE (29 tests) |
| 2 | Load balancing over several upstreams: round-robin, least-connections | DONE (16 more tests, 45 in total) |
| 3 | Health checks (active + passive), retries for safe requests, separate connect timeout | DONE (44 more tests, 89 in total) |
| 4 | Run it on `portfolio-a2` and MEASURE it (plan: `STAGE4_PLAN.md`) | IN PROGRESS: tooling and tests done (4a); server run not done yet |

No benchmark numbers are claimed anywhere in this project. They will be added from real measurements after stage 4.

## Run

```bash
npm install
npm run build
UPSTREAM=http://127.0.0.1:3000 PORT=8080 node dist/index.js

# several upstreams, fewest active requests wins:
UPSTREAM=http://127.0.0.1:3000,http://127.0.0.1:3001 STRATEGY=least-connections node dist/index.js
```

| Env var | Default | Meaning |
|---|---|---|
| `UPSTREAM` | required | Where requests go: one URL or a comma separated list. `http://` only, no path prefix. |
| `STRATEGY` | `round-robin` | `round-robin` or `least-connections` (only matters with several upstreams). |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Where the proxy listens. |
| `TRUST_FORWARDED` | `false` | `true` only when a proxy YOU control (for example Caddy) sits in front: keep and extend its `X-Forwarded-For`. |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Idle timeout against the upstream; exceeded -> 504. |
| `CONNECT_TIMEOUT_MS` | `3000` | Give up if the TCP connection is not made in time (retryable). |
| `RETRIES` | `1` | Extra attempts for body-less GET/HEAD/OPTIONS that fail before any response byte. `0` turns it off. |
| `EJECT_AFTER` / `EJECT_MS` | `3` / `10000` | Passive health: consecutive connection failures before an upstream is skipped, and for how long. |
| `HEALTH_PATH` | unset | Turns on ACTIVE health checks: probe this path (for example `/health`) on every upstream. |
| `HEALTH_INTERVAL_MS` | `5000` | Time between probe rounds (only with `HEALTH_PATH`). |
| `STATS_INTERVAL_MS` | unset | Log one `{"msg":"stats", targets:[{upstream, active, healthy, ejected}]}` line per interval (to spot counter leaks in long runs). |
| `REQUEST_LOG` | on | `false` turns off the per-request log line (health and stats lines stay). Added to measure what the logging costs; the answer is in the stage 4 results, not assumed. |

One JSON log line is written per request: `{method, url, status, aborted, ms, upstream, attempts, error}` (`upstream` is the last one tried; `attempts` of 2 or more means it was retried; `error` is the last upstream error, for example `ECONNREFUSED`, `ECONNRESET`, `ConnectTimeoutError`, `UpstreamTimeoutError` or `UPSTREAM_ABORTED`, and on a 2xx with `attempts` >= 2 it is the failure a retry hid). Health changes are logged as `{"msg":"health", upstream, healthy, reason}`.

## What stage 1 does (and the test that proves it)

| Behaviour | Why | Test |
|---|---|---|
| Streams request and response bodies with `pipe`, never buffers them | Memory stays flat for large uploads and downloads | `streams a large request body`, `streams a large response body` |
| Strips hop-by-hop headers, including ones named in `Connection` | They describe one TCP hop, not the message | `does not forward hop-by-hop headers...` |
| Overwrites `X-Forwarded-For` unless `TRUST_FORWARDED=true` | A client can send any value; trusting it breaks per-IP limits and audit logs | `overwrites a spoofed X-Forwarded-For by default` |
| Upstream refused -> 502; upstream silent -> 504 | The client learns whether the proxy or the upstream is at fault | `returns 502...`, `returns 504...` |
| Upstream dies mid-body -> drop the client connection | Otherwise a truncated download looks like a success | `drops the client connection when the upstream dies mid-response` |
| Client leaves -> cancel the upstream request | No wasted work, no leaked sockets | `cancels the upstream request when the client disconnects` |
| `Via` header + 508 on loops | A proxy that points at itself would circle until sockets run out | `returns 508...` |
| Re-frames a chunked request body | `Transfer-Encoding` is hop-by-hop, but the body still has no length | `re-frames a chunked request body` |
| Keep-alive agent to the upstream | One TCP handshake is reused across many requests | (behaviour of `http.Agent`, no dedicated test) |

I checked that the key tests can fail: removing the mid-response `res.destroy()`, the client-abort `up.destroy()`, or the
`trustForwarded` check each turned the matching test red.

## What stage 2 adds

`src/balancer.ts` is a small class with no HTTP in it, so it is unit-tested without sockets. `acquire()` picks a target
and hands back a lease; `release()` gives the slot back and counts only once.

| Strategy | Rule | Good for | Weak spot |
|---|---|---|---|
| `round-robin` | next target in order, ignores load | requests that cost about the same | one slow upstream still gets every Nth request |
| `least-connections` | target with the fewest requests in flight; ties rotate | requests of uneven length (uploads, reports) | counts requests, not how heavy they are |

- Pick and increment happen in one synchronous step on Node's single thread, so no lock is needed.
- The lease is released in one place, the response's `close` event, which every path reaches (success, upstream error,
  client abort, mid-response drop). A test checks all four paths leave the counters at zero, and that the counter was
  really up while a request hung.
- With several proxy PROCESSES each one keeps its own counters, so least-connections is per process, not global.
- Balancing alone is not availability: on its own, a dead upstream keeps receiving its share and answers 502 (test:
  `with retries and ejection switched off, a dead upstream still gets its share`). Stage 3 adds what is missing.

Checked by breaking the code: never releasing the lease, making least-connections ignore load, and changing the tie
rule each turned the matching tests red.

## What stage 3 adds

| Mechanism | Rule | Where |
|---|---|---|
| Passive ejection | `EJECT_AFTER` (3) consecutive connection failures on real traffic -> skipped for `EJECT_MS` (10 s). After that ONE failure ejects it again (a single trial); one success wipes the slate. | `balancer.ts` |
| What counts as a failure | refused, reset, connect timeout, idle timeout, a response cut short by the upstream. NOT an HTTP 500: the server is reachable, the application is what is broken. NOT a client that left. | `proxy.ts` |
| Active checks (optional) | every `HEALTH_INTERVAL_MS` request `HEALTH_PATH` on each upstream; 2xx/3xx is healthy. 2 failures in a row -> down, 2 passes in a row -> up (no flapping on one blip). | `health.ts` |
| Nothing available | answer `503` with `Retry-After: 1` | `proxy.ts` |
| Retries | only GET/HEAD/OPTIONS with NO body (a streamed body cannot be replayed), only before any response byte, only for connection-level errors and connect timeouts, preferring a DIFFERENT upstream. | `proxy.ts` |
| Not retried on purpose | POST/PUT/DELETE (not safe to repeat), anything after response bytes reached the client, response-idle timeouts (slow is not unreachable; retrying doubles the wait and loads a struggling server) | `proxy.ts` |
| Connect timeout | separate from the idle timeout: an unreachable machine fails in seconds so the retry can go elsewhere | `connect.ts` |

Checked by breaking the code (each break turned the matching test red): retrying idle timeouts, retrying POST, counting a
client abort as an upstream failure, never reporting success, retrying without avoiding the failed target, ignoring the
probe thresholds, never expiring an ejection. One break was NOT caught at first (a body-less POST would have been
retried); that gap is now closed by a test.

## Not implemented (on purpose, so nobody assumes it)

- Weights, sticky sessions, draining, runtime config reload.
- "Panic mode" (sending traffic anyway when everything looks down): we answer 503 instead.
- Retry budgets and backoff. Worst case a failing request costs 1 + `RETRIES` upstream attempts; there is no global limit.
- Slow start after an upstream comes back: it gets its full share at once.
- Health state is per process, like the counters.
- A real network black hole is not tested for the connect timeout: the timer helper is tested with a fake socket, and the
  proxy wiring only with a slow-but-reachable upstream.
- Graceful shutdown: a test now starts the real CLI and sends SIGTERM, but it only runs on Linux/macOS (Windows cannot send a catchable SIGTERM). It has NOT been run yet at the time of writing; see the stage 4 results.
- WebSocket / `Upgrade` (the `upgrade` event is not handled, so such connections are closed).
- HTTPS upstreams and TLS termination (Caddy does TLS in front of this).
- Request body size limits, rate limiting, caching, compression.

## Files

- `src/headers.ts` -- pure functions: hop-by-hop stripping, forwarded headers, Via and loop detection.
- `src/balancer.ts` -- `Balancer`: round-robin and least-connections with leases, plus health state (ejection, healthy flag).
- `src/health.ts` -- `HealthChecker` (active probes with thresholds) and the HTTP probe.
- `src/connect.ts` -- `watchConnect`: the connect timeout.
- `src/proxy.ts` -- `createProxy()`: the request lifecycle, error mapping, aborts, keep-alive agent.
- `src/index.ts` -- CLI: environment variables, JSON logging, graceful shutdown.
- `bench/` -- the stage 4 experiments (own `package.json` with a pinned `autocannon`, so the proxy keeps zero dependencies): `upstream.mjs` test server, `scenarios.mjs` E1-E9, `run.mjs` runner that saves raw JSON and a generated `SUMMARY.md`. Run `BENCH_QUICK=1 node run.mjs all` for a short dry run; real runs are described in `STAGE4_PLAN.md`.
- `test/` -- vitest; the proxy tests run real upstream servers on ephemeral ports. Files run one at a time (`vitest.config.ts`) because the helper that makes a "dead" port frees it and could race with another file.

Interview questions for this project: `interview/data/p12-reverse-proxy/`.
