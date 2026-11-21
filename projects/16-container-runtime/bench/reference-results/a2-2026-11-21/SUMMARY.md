### Run `a2-2026-11-21`

2026-11-21 18:05:16 UTC, aarch64, 2 CPUs (Neoverse-N1), kernel 7.0.0-1013-oracle, Python 3.12.3, commit `13f7698`, load average before 0.18 0.16 0.16, 11273 MiB available. Raw data: `bench/reference-results/a2-2026-11-21/`. Median, min-max in brackets.

#### L0 Start + stop of an empty container (`true`)

Outer = measured by this script around the whole `python3 -m minibox run` process (Python start-up included); inner = minibox's own clock from before the cgroup is created to after the command exited.

| runs | outer ms | inner ms |
|---|---|---|
| 20 | 105 (101-114) | 18 (17-28) |

Raw: `l0-start.json`

#### L1 pids.max = 32

`pids.peak` = most processes the cgroup ever had; `pids.events max` = forks the kernel refused. busybox sh exits when a fork fails, which is what ends the fork bomb.

| case | runs | exit code | pids.peak | pids.events max | `can't fork` messages | wall ms |
|---|---|---|---|---|---|---|
| 100 sleepers, pids.max=32 | 3 | 2 (2-2) | 32 (32-32) | 1 (1-1) | 1 (1-1) | 30 (27-31) |
| fork bomb, pids.max=32 | 3 | 2 (2-2) | 32 (32-32) | 31 (29-64) | 30 (28-63) | 27 (26-34) |

Raw: `l1-pids.json`

#### L2 memory.max = 64M (memory.swap.max = 0)

`oom_kill` from memory.events; peak from memory.peak. Exit 137 = killed by SIGKILL (128 + 9).

| case | runs | exit code | printed `survived` | oom_kill | memory.events max | memory.peak MiB | wall ms |
|---|---|---|---|---|---|---|---|
| hog to 128 MiB string, memory.max=64M | 3 | 137 (137-137) | 0 of 3 | 1 (1-1) | 37 (37-37) | 64.0 (64.0-64.0) | 197 (196-201) |
| 16 MiB string, memory.max=64M | 3 | 0 (0-0) | 3 of 3 | 0 (0-0) | 0 (0-0) | 33.5 (33.3-33.5) | 101 (100-104) |

Raw: `l2-memory.json`

#### L3 cpu.max: one busy loop (`timeout N sh -c 'while :; do :; done'`)

CPU share = cpu.stat usage_usec / minibox's wall time (container start-up included, so slightly below the quota). One busy loop can use at most 1 CPU, so `1.0` and no limit should match.

| cpus | cpu.max | runs | CPU share | nr_periods | nr_throttled | throttled ms | wall s |
|---|---|---|---|---|---|---|---|
| no limit | `max 100000` | 3 | 0.998 (0.997-0.998) | 0 (0-0) | 0 (0-0) | 0 (0-0) | 5.02 (5.02-5.02) |
| 1.0 | `100000 100000` | 3 | 0.998 (0.997-0.998) | 50 (50-51) | 0 (0-0) | 0 (0-0) | 5.02 (5.02-5.03) |
| 0.5 | `50000 100000` | 3 | 0.501 (0.501-0.507) | 50 (50-51) | 50 (50-50) | 2493 (2465-2498) | 5.02 (5.02-5.02) |
| 0.25 | `25000 100000` | 3 | 0.252 (0.251-0.253) | 51 (51-51) | 50 (50-51) | 3750 (3744-3763) | 5.02 (5.02-5.05) |

Raw: `l3-cpu.json`

