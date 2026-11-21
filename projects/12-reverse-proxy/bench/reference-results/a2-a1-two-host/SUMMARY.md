# Measured results

Date: 2026-11-21T11:58:00.550Z  |  Node v20.20.1  |  linux/arm64  |  2 CPUs (Neoverse-N1)  |  commit a6d2058

Whole run took 283s. CPU time over the run (all cores): busy 48.05%, idle 46.08%, iowait 0.01%, STEAL 5.86% (steal is time the hypervisor gave to other tenants; high steal means noisy numbers).

Two machines: the load generator and the proxy on one server, the test upstreams on a second server, over the private network. (This line was corrected after the run: the runner used to print a one-machine sentence for every run.)

## X1 - network round trip between the two machines (TCP connect time)

Time to open a TCP connection from the proxy machine to the upstream machine over the private network, repeated; this is about one round trip.

| samples | min ms | p50 ms | p99 ms | max ms |
|---|---|---|---|---|
| 200 | 0.56 | 0.7 | 1.51 | 3.98 |

Raw data: `x1.json`

## X2 - what the proxy costs when the upstream is on ANOTHER machine

Load generator and proxy on one machine, the upstream on a second machine over the private network (the upstream no longer shares the proxy's CPU). 32 connections and 1 connection, median of 3 runs of 15s (the 1-connection runs are shorter).

| target | req/s (median) | req/s (min-max) | p50 ms | p97.5 ms | p99 ms | errors+non2xx |
|---|---|---|---|---|---|---|
| direct (other machine) | 6616 | 6599 - 6685 | 4 | 8 | 9 | 0 |
| through the proxy | 2844 | 2578 - 2923 | 11 | 18 | 19 | 0 |
| through the proxy, request log off | 3264 | 3123 - 3615 | 9 | 14 | 18 | 0 |
| direct (other machine) [1 connection] | 1996 | 1776 - 2083 | 0 | 0 | 0 | 0 |
| through the proxy [1 connection] | 1042 | 1038 - 1141 | 0 | 1 | 1 | 0 |
| through the proxy, request log off [1 connection] | 1105 | 1086 - 1105 | 0 | 1 | 1 | 0 |

Raw data: `x2.json`

## X3 - round-robin vs least-connections, upstreams on another machine (one is 40 ms slower)

Same question as E2, but over the network. 32 connections, median of 3 runs of 15s per strategy.

| strategy | req/s | p50 ms | p97.5 ms | p99 ms | slow share |
|---|---|---|---|---|---|
| round-robin | 1496 | 26 | 42 | 45 | 50% |
| least-connections | 2810 | 7 | 51 | 53 | 9% |

Raw data: `x3.json`

## X4 - three kinds of failure to reach an upstream on another machine

"raw TCP" is a plain connection attempt from this machine (3.5 s limit); the last three columns are what a client sees through the proxy (retries off, connect timeout 2000 ms).

| case | raw TCP result | raw TCP ms | status via proxy | ms via proxy | error the proxy recorded |
|---|---|---|---|---|---|
| port the host firewall REJECTs | EHOSTUNREACH | 2.3 | 502 | 50 | EHOSTUNREACH |
| port open in the firewall, nothing listening | ECONNREFUSED | 1 | 502 | 13 | ECONNREFUSED |
| port the cloud network silently drops | TIMEOUT | 3500.8 | 504 | 2013 | ConnectTimeoutError |

Raw data: `x4.json`

