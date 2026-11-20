# Measured results

Date: 2026-11-20T10:27:15.772Z  |  Node v20.20.1  |  linux/arm64  |  2 CPUs (Neoverse-N1)  |  commit 220395a

Whole run took 1846s. CPU time over the run (all cores): busy 88.54%, idle 11.23%, iowait 0%, STEAL 0.23% (steal is time the hypervisor gave to other tenants; high steal means noisy numbers).

Everything ran on ONE machine (load generator, proxy and upstreams share the CPUs). Read the comparisons, not the absolute numbers.

## E8 - 1800s soak with random client aborts, POSTs and a flaky upstream (5% connection resets)

16 concurrent clients; 70% GET, 10% slow GET, 10% GET aborted by the client after 1-30 ms, 10% POST. Least-connections, retries 1, active checks every 2 s. After the clients stop, every upstream's active count must be 0.

| requests logged | client saw | proxy errors seen | retried | health events | final active counts | proxy RSS MiB first/last/max |
|---|---|---|---|---|---|---|
| 2851253 | {"200":2281109,"client-aborted":284550,"POST 200":282890,"POST 502":2713} | {"ECONNRESET":26532} | 23819 | 164 | [0,0,0] | 83.4 / 90.2 / 91.1 |

Raw data: `e8.json`

