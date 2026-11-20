# Measured results

Date: 2026-11-20T11:14:58.585Z  |  Node v20.20.1  |  linux/arm64  |  2 CPUs (Neoverse-N1)  |  commit 2f72f4e

Whole run took 255s. CPU time over the run (all cores): busy 1.75%, idle 98.14%, iowait 0.01%, STEAL 0.1% (steal is time the hypervisor gave to other tenants; high steal means noisy numbers).

Everything ran on ONE machine (load generator, proxy and upstreams share the CPUs). Read the comparisons, not the absolute numbers.

## E4 - stale keep-alive connections: do resets happen, and do retries hide them?

Two kinds of upstream, both closing idle connections after 200 ms: a Node server, and a raw one that sends no Keep-Alive hint. sequential GETs with random gaps of 150-260 ms, so some requests arrive just as the upstream closes the idle connection. Seeded random numbers: the gaps are the same in both rows.

| upstream | retries | requests | client saw (status: count) | upstream errors seen by proxy | requests that were retried |
|---|---|---|---|---|---|
| node server (sends a Keep-Alive hint) | 0 | 300 | {"200":300} | {} | 0 |
| node server (sends a Keep-Alive hint) | 1 | 300 | {"200":300} | {} | 0 |
| raw server (no hint) | 0 | 300 | {"200":299,"502":1} | {"ECONNRESET":1} | 0 |
| raw server (no hint) | 1 | 300 | {"200":300} | {"ECONNRESET":2} | 2 |

Raw data: `e4.json`

## E9 - graceful shutdown with 10 requests in flight (each takes 2 s, SIGTERM after 0.5 s)

SIGTERM is sent to the real CLI process. The in-flight requests must still complete, the process must exit with code 0, and it must stop accepting new connections.

| in-flight completed 200 | failed | exit code | exit after SIGTERM ms | new connection refused afterwards |
|---|---|---|---|---|
| 10 | 0 | 0 | 1611 | yes |

Raw data: `e9.json`

