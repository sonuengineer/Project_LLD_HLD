# Measured results

Date: 2026-11-20T10:17:21.230Z  |  Node v20.20.1  |  linux/arm64  |  2 CPUs (Neoverse-N1)  |  commit 220395a

Whole run took 554s. CPU time over the run (all cores): busy 59.36%, idle 40.43%, iowait 0.01%, STEAL 0.2% (steal is time the hypervisor gave to other tenants; high steal means noisy numbers).

Everything ran on ONE machine (load generator, proxy and upstreams share the CPUs). Read the comparisons, not the absolute numbers.

## E1 - what does the proxy cost? (32 connections, tiny responses)

Same machine runs the load generator, the proxy and the upstream, so they compete for CPU. Compare the two rows, do not read them as capacity. 3 run(s) of 15s each, rotating through the three targets.

| target | req/s (median) | req/s (min-max) | p50 ms | p97.5 ms | p99 ms | errors+non2xx |
|---|---|---|---|---|---|---|
| direct | 14953 | 14808 - 15035 | 2 | 4 | 4 | 0 |
| proxy | 3586 | 3251 - 3608 | 8 | 12 | 14 | 0 |
| proxy, request log off | 4044 | 4026 - 4105 | 7 | 11 | 12 | 0 |

Raw data: `e1.json`

## E2 - round-robin vs least-connections with one slow upstream (40 ms extra)

Two upstreams: one answers at once, one waits 40 ms. 32 connections. 3 run(s) of 15s per strategy. "slow share" is the fraction of requests the slow one received (from the proxy log).

| strategy | req/s | p50 ms | p97.5 ms | p99 ms | slow share |
|---|---|---|---|---|---|
| round-robin | 1524 | 15 | 43 | 46 | 50% |
| least-connections | 3400 | 6 | 48 | 49 | 7.3% |

Raw data: `e2.json`

## E3 - an upstream is killed under load (SIGKILL, no warning)

2 upstreams, round-robin, 32 connections, 14s per run, upstream B killed at 5s. "bad" = 5xx or a body cut short, seen by the proxy after the kill. "last bad ms" = how long after the kill the last bad request finished. "down event ms" = kill until the health event (only where one fired). 3 run(s) per row.

| configuration | bad requests (median, min-max) | bad share | requests saved by retry | last bad ms | down event ms |
|---|---|---|---|---|---|
| retries 0, passive only | 16 (9 - 21) | 0% | 0 | 17 | 10 |
| retries 1, passive only | 0 (0 - 0) | 0% | 7 | - | 8 |
| retries 0, active checks every 1s | 18 (9 - 18) | 0.1% | 0 | 24 | 10 |
| retries 1, active checks every 1s | 0 (0 - 0) | 0% | 8 | - | 9 |

Raw data: `e3.json`

## E4 - stale keep-alive connections: do resets happen, and do retries hide them?

One upstream with a 200 ms keep-alive timeout; sequential GETs with random gaps of 150-260 ms, so some requests arrive just as the upstream closes the idle connection. Seeded random numbers: the gaps are the same in both rows.

| retries | requests | client saw (status: count) | upstream errors seen by proxy | requests that were retried |
|---|---|---|---|---|
| 0 | 300 | {"200":300} | {} | 0 |
| 1 | 300 | {"200":300} | {} | 0 |

Raw data: `e4.json`

## E5 - connect timeout against a REAL black hole (packets silently dropped)

One upstream is unreachable because the firewall drops its SYN packets (loopback, rule removed afterwards). Upstream order [dead, live], round-robin, retries 1, default ejection (3 failures).

| connect timeout ms | request | first target | status | ms | attempts | last error |
|---|---|---|---|---|---|---|
| 1000 | GET #1 | live | 200 | 1020 | 2 | ConnectTimeoutError |
| 1000 | GET #2 | live | 200 | 1005 | 2 | ConnectTimeoutError |
| 1000 | GET #3 | live | 200 | 1006 | 2 | ConnectTimeoutError |
| 1000 | GET #4 | live | 200 | 4 | 1 |  |
| 1000 | GET #5 | live | 200 | 3 | 1 |  |
| 1000 | GET #6 | live | 200 | 3 | 1 |  |
| 1000 | GET #7 | live | 200 | 2 | 1 |  |
| 1000 | GET #8 | live | 200 | 2 | 1 |  |
| 3000 | GET #1 | live | 200 | 3018 | 2 | ConnectTimeoutError |
| 3000 | GET #2 | live | 200 | 3007 | 2 | ConnectTimeoutError |
| 3000 | GET #3 | live | 200 | 3006 | 2 | ConnectTimeoutError |
| 3000 | GET #4 | live | 200 | 3 | 1 |  |
| 3000 | GET #5 | live | 200 | 2 | 1 |  |
| 3000 | GET #6 | live | 200 | 3 | 1 |  |
| 3000 | GET #7 | live | 200 | 2 | 1 |  |
| 3000 | GET #8 | live | 200 | 3 | 1 |  |
| 1000 | POST #1 | dead | 504 | 1118 | 1 | ConnectTimeoutError |

Raw data: `e5.json`

## E6 - which error does a closed port give? (same host, loopback)

Closed port on the SAME machine. A closed port on ANOTHER machine behind a REJECT firewall rule was NOT measured (needs the two-host mode).

| platform | status to client | error the proxy recorded |
|---|---|---|
| linux | 502 | ECONNREFUSED |

Raw data: `e6.json`

## E7 - memory while streaming 1024 MiB through the proxy

Resident memory (RSS) of the proxy and the upstream, sampled every 200 ms, before and during one large transfer. Streaming should keep the proxy near its idle size; buffering would grow it by about the file size.

| MiB sent | bytes received | complete? | seconds | proxy RSS idle MiB | proxy RSS max MiB | proxy growth MiB | upstream RSS max MiB |
|---|---|---|---|---|---|---|---|
| 1024 | 1073741824 | yes | 2.7 | 41.1 | 81.7 | 40.6 | 48.8 |

Raw data: `e7.json`

## E9 - graceful shutdown with 10 requests in flight (each takes 2 s, SIGTERM after 0.5 s)

SIGTERM is sent to the real CLI process. The in-flight requests must still complete, the process must exit with code 0, and it must stop accepting new connections.

| in-flight completed 200 | failed | exit code | exit after SIGTERM ms | new connection refused afterwards |
|---|---|---|---|---|
| 10 | 0 | 0 | 4540 | yes |

Raw data: `e9.json`

