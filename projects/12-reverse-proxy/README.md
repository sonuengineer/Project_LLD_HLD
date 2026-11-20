# H11 -- Reverse Proxy + Load Balancer (TypeScript, zero runtime dependencies)

A hand-written HTTP reverse proxy on Node's built-in `http` module. Built in stages so every claim here is backed by
code and tests that exist today.

## Status

| Stage | What | Status |
|---|---|---|
| 1 | Reverse proxy to ONE upstream: streaming, headers, errors, timeouts, loop detection, graceful shutdown | DONE (29 tests) |
| 2 | Load balancing over several upstreams: round-robin, least-connections | DONE (16 more tests, 45 in total) |
| 3 | Health checks, passive failure detection, retries for idempotent requests | Not started |
| 4 | Deploy on the Oracle servers (proxy on `portfolio-a2`, apps on `portfolio-a1`) and measure | Not started |

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

One JSON log line is written per request: `{method, url, status, aborted, ms, upstream}` (`upstream` is the `host:port` that served it).

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
- **Known limit until stage 3:** there are no health checks. A dead upstream still receives its share of traffic and
  answers 502 (test: `still sends its share of traffic to a dead upstream`). Do not claim failover.

Checked by breaking the code: never releasing the lease, making least-connections ignore load, and changing the tie
rule each turned the matching tests red.

## Not implemented (on purpose, so nobody assumes it)

- Health checks, failover, retries, weights, sticky sessions (stage 3 and later).
- WebSocket / `Upgrade` (the `upgrade` event is not handled, so such connections are closed).
- HTTPS upstreams and TLS termination (Caddy does TLS in front of this).
- Request body size limits, rate limiting, caching, compression.

## Files

- `src/headers.ts` -- pure functions: hop-by-hop stripping, forwarded headers, Via and loop detection.
- `src/balancer.ts` -- `Balancer`: round-robin and least-connections with leases.
- `src/proxy.ts` -- `createProxy()`: the request lifecycle, error mapping, aborts, keep-alive agent.
- `src/index.ts` -- CLI: environment variables, JSON logging, graceful shutdown.
- `test/` -- vitest; the proxy tests run real upstream servers on ephemeral ports.

Interview questions for this project: `interview/data/p12-reverse-proxy/`.
