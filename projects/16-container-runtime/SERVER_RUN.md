# H16 minibox on portfolio-a2: what was done on the server (2026-11-21)

Why a server at all: minibox needs Linux, root, cgroup v2 and overlayfs; the development PC is Windows. All
integration tests, the limit measurements and the mutation checks ran on `portfolio-a2` (Oracle Ampere A1, 2 vCPUs,
12 GB RAM, 4 GB swap file, Ubuntu 24.04, kernel 7.0.0-1013-oracle, Python 3.12.3, passwordless sudo). Same method as
`deployment/08-message-broker-cluster.md`: look before you touch, everything temporary, clean up, prove it.

`<A2_IP>` is the public address used only for SSH; it is not written in this repo. No port was opened, no iptables
rule was added or changed, nothing was installed system-wide (no apt, no pip into the system Python), sshd / Caddy /
Docker were not touched.

## 1. Look before you touch (read only)

Snapshot (same command as deployment/08 section 8.1, plus a node check), kept locally, NOT in the repo:

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'hostname; uname -m; free -m | head -2; ss -ltnH | awk "{print \$4}" | sort;
  sudo -n iptables -S INPUT; sudo -n docker ps --format "{{.Names}} {{.Status}}"; ls -1 ~; ls -d /opt/node'
```

Also checked, read only: cgroup v2 with `cpuset cpu io memory hugetlb pids rdma misc dmem` already in the root's
`cgroup.subtree_control` (so minibox never has to change the root cgroup), `overlay` in /proc/filesystems, `/` mounted
`shared` (the reason for mount step 1 in the README), 29 lines in /proc/mounts, no `/sys/fs/cgroup/minibox`, a 4 GB
swap file with 0 B used, Docker installed and owning the FORWARD chain and a nat MASQUERADE rule (the reason stage 4
was left out, PLAN.md), no pytest on the system Python, no `pip` module.

## 2. Everything lived in ~/h16

| Path | What | How it got there |
|---|---|---|
| `~/h16/wheels`, `~/h16/vendor` | pytest 9.2.0 + its pure-Python dependencies (pluggy, iniconfig, packaging, pygments, colorama) | `pip download` on the PC from PyPI (pip checks the hashes), shipped with tar, unpacked with `python3 -m zipfile -e`; used via `PYTHONPATH`, never installed |
| `~/h16/app` | the working copy of `projects/16-container-runtime` | `tar -c ... \| ssh ... 'tar -x -C ~/h16/app'` before every run |
| `~/h16/images/alpine` | alpine:3.20 for arm64 | pulled by minibox itself (`sudo python3 -m minibox pull alpine:3.20 --dest ~/h16/images/alpine`) |
| `~/h16/state`, `~/h16/tmp`, `~/h16/rootfs-copy` | overlay upper/work/merged dirs (`--state-dir`), pytest's `--basetemp`, a copy of the image for mutation M19 | created by the runs |
| `~/h16/results` | bench output | `bench/limits.py`, copied home with tar |

Outside ~/h16 the only things created were the cgroups `/sys/fs/cgroup/minibox/<name>` (removed by minibox after
each container) and mounts inside the containers' own mount namespaces (gone when each container ended). Tests and
bench always passed `--state-dir`, so the default `/run/minibox` was never created.

Tests were run as root with:

```bash
cd ~/h16/app/16-container-runtime && sudo -n env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=$HOME/h16/vendor \
  MINIBOX_TEST_ROOTFS=$HOME/h16/images/alpine/rootfs python3 -m pytest -p no:cacheprovider --basetemp=$HOME/h16/tmp
```

`PYTHONDONTWRITEBYTECODE=1` because root-owned `__pycache__` files made the next shipping step fail once
(`Permission denied` on `rm`); after that the ship step removes the old copy with `sudo -n rm -rf`.

## 3. What went wrong (and was fixed) on the server

1. **A command was PID 3, not 2** in the very first manual run. `ctypes.util.find_library("c")` runs `ldconfig` as a
   subprocess, and inside the container that fork took PID 2. Fix: load `libc.so.6` directly first
   (`minibox/libc.py`). Found because `echo $$` printed 3.
2. **The first fork-bomb test passed for the wrong reason**: `bomb() { bomb | bomb & }` never grew past 4 processes
   in busybox sh. Replaced by `bomb() { bomb & bomb; }` and a bounded 100-sleeper test; busybox sh gives up when a fork
   fails, which is what ends the bomb (see README).
3. **Mutation M6 left two containers running** (18:10): with INIT not forwarding SIGTERM, the test's container never
   stopped, and the following mutation runs saw its cgroups. Stopped by writing `1` to their `cgroup.kill` (the
   host-side minibox processes then cleaned up by themselves). Fix in the tests: the cleanup fixture now kills and
   removes any cgroup a failed test leaves, BEFORE failing it. M6 and M8-M11 were re-run on a clean server; the README
   table has the re-run numbers.
4. **A fork bomb ran without its cgroup limit (18:15, mutation M13).** M13 removes the pipe that makes INIT wait
   until it is in its cgroup. The mutation run for it included the unbounded fork-bomb test (the runs for the
   pids/memory/cpu limit mutations already excluded it, this one did not). With the race lost, the bomb ran in the
   SSH session's own cgroup: the 1-minute load average reached 3172, and the kernel log shows `fork rejected by pids
   controller in /user.slice/user-1001.slice/session-645.scope` -- systemd's per-session task limit stopped it, and
   the bomb's processes died with the container's PID namespace. Checked right after (18:15:46): 186 processes,
   memory unchanged, Caddy, Docker and sshd all `active`; load average back to 0.96 by 18:24. Fix: the mutation
   runner now deselects the fork-bomb test for EVERY mutation (and the README says it was never run against mutated
   code on purpose after this).
5. **Mutation M4 leaked mounts into the host (18:18), as predicted.** Without making `/` private first, the
   container's overlay, proc, /dev tmpfs, devpts and shm mounts propagated to the host namespace (10 lines in
   /proc/mounts) and pivot_root refused the shared mount. Removed with `sudo umount -R <state>/merged` for the two
   containers; /proc/mounts back to 29 lines, 0 mentioning h16.
6. Mutation M17's first version removed the only statement of an `if` block (a SyntaxError, so all 9 tests failed
   for the wrong reason). Re-run with `pass` in its place: 2 failed.

## 4. Cleanup and proof (18:24 UTC)

```bash
ssh ... 'pgrep -af "python3 -m [m]inibox"; ls -d /sys/fs/cgroup/minibox; grep -c h16 /proc/mounts; grep -c overlay /proc/mounts;
  wc -l < /proc/mounts; sudo -n rm -rf ~/h16; ls -d ~/h16; ls -d /run/minibox; hostname; swapon --show'
```

Result: no minibox processes, no `/sys/fs/cgroup/minibox`, 0 mounts mentioning h16, 0 overlay mounts, 29 lines in
/proc/mounts (as before), `~/h16` gone, no `/run/minibox`, hostname unchanged (`portfolio-a2`), swap 0 B used, Caddy /
Docker / sshd active.

After-snapshot compared line by line with the before-snapshot (memory lines and the header with the time excluded):
**identical** -- the same listening ports, the same iptables INPUT rules, no containers, the same home folder
contents, `/opt/node` still there.

## 5. Timeline (UTC, 2026-11-21)

| Time | What |
|---|---|
| 17:47:40 | before-snapshot; read-only checks (cgroup controllers, overlay, mount propagation, iptables FORWARD/nat, swap, Python) |
| 17:58:57 | `~/h16` created; pytest wheels shipped and unpacked into `~/h16/vendor` |
| 17:59:08 | code shipped; alpine:3.20 pulled by minibox (1 layer, 4092319 bytes, all digests verified, about 4 s); pulled again as root so the rootfs has uid 0 owners |
| 18:00-18:04 | first container by hand (found the PID 3 issue), integration test iterations (fork bomb test redone, setup-error handling) |
| 18:05:16-18:06:22 | `bench/limits.py`, commit `13f7698`: L0 start time (20 runs), L1 pids, L2 memory, L3 cpu (3 runs each) |
| 18:06:33 | results copied home into `bench/reference-results/a2-2026-11-21/` (checked: no addresses or host names in them) |
| 18:08:55-18:22:28 | 29 mutation checks (runner in the PC's scratch folder, never in the repo); incidents 3-6 above at 18:10, 18:15, 18:18, 18:20 |
| 18:20:32 | clean tree, full suite: 192 passed (140 unit + 52 integration) |
| 18:24:22 | cleanup: `~/h16` deleted, no cgroups, no mounts, no processes |
| 18:24:23 | after-snapshot identical to the before-snapshot |

## 6. Second run: stage 4a networking (2026-11-22, 13:35-13:47 UTC)

Same server, same rules: everything under `~/h16`, nothing installed, cleaned up afterwards, compared with a
before-snapshot. Because this stage touches networking, the snapshot was extended: listening ports, `ip -br link`,
`ip -4 -br addr`, `ip -4 route`, the full `iptables -S` and `iptables -t nat -S`, `net.ipv4.ip_forward`, running
containers, Caddy / Docker / sshd state, failed units, the home folder, and the minibox paths
(`/sys/fs/cgroup/minibox`, `/run/minibox`, `/run/minibox-net.lock`).

Read-only findings that shaped the design (from the before-snapshot):

- INPUT accepts ICMP and RELATED/ESTABLISHED, and rejects new TCP except 22/80/443. So: the container can ping the host
  end; the host can open TCP to the container (the replies are ESTABLISHED); the container cannot open TCP to the host.
- FORWARD policy is DROP (Docker's chains, then a REJECT) and `ip_forward` is 1 (Docker turned it on). minibox adds
  no default route in the container, so nothing ever reaches FORWARD.
- Nothing on the server is in `10.200.0.0/16` (checked on the unmasked snapshot; 0 matches).

Steps: pytest wheels shipped into `~/h16/vendor` (13:36:10), code shipped with tar, alpine:3.20 pulled by minibox as
the `ubuntu` user (digests verified). Network tests: first run 7 passed, 2 failed because the tests read
`/sys/class/net` inside the container and minibox does not mount `/sys` (test bug, fixed to use `/proc/net/dev` and
`ip link`); then 9/9. Full suite 225/225 (13:37). The 11 network mutations (13:38-13:41, the first attempt did not run
at all: the runner called WSL's `bash` instead of Git Bash) found N5 and N7 not caught; two tests were added; both then
red in 3 of 3 runs. Final: all 11 caught (13:42-13:44), clean full suite 227/227 (13:45).

**My mistake, no harm:** re-checking M13 with the renamed pipe, I first ran limits + isolation WITHOUT deselecting the
fork bomb test -- the rule from incident 4 above. It did no harm only because that version of the mutation (INIT's
read removed, the host's write kept) made every container fail at setup with `Broken pipe` before any command ran.
Checked at once (13:45:37): load 0.63, 183 processes, services active, no failed units, no cgroups left. The real
M13 (both sides removed) was then run with `-k 'not fork_bomb'`.

Cleanup (13:47:16): no minibox processes, `~/h16` and `/run/minibox-net.lock` deleted. After-snapshot compared with
the before-snapshot (header time and load line excluded): **identical** -- the same links (no `mbx*`, no stray
`eth0`), addresses, routes, filter and nat rules, `ip_forward`, services and home folder. Load average 0.38.
