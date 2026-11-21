# H16 (A1 "Build your own Docker") -- minibox, a container runtime written by hand

`minibox` runs a command in a container the way `docker run` does underneath: new namespaces, `pivot_root` into an
image's root filesystem, a fresh `/proc` and a minimal `/dev`, its own PID 1, cgroup v2 limits, and an overlayfs root
so the image is never modified. It can pull that image from Docker Hub itself. Python 3.12 standard library only;
three syscalls (mount, umount2, pivot_root) go through `ctypes`.

```
sudo python3 -m minibox pull alpine:3.20 --dest ~/images/alpine
sudo python3 -m minibox run --rootfs ~/images/alpine/rootfs --hostname box1 --memory 64M --pids 32 --cpus 0.5 \
    -- /bin/sh -c 'hostname; echo "I am PID $$"; ps'
```

Status (2026-11-21): stages 1-3 done, tested and measured on `portfolio-a2` (Ubuntu 24.04, arm64, kernel 7.0,
cgroup v2). Stage 4 (veth + bridge + NAT) deliberately NOT done; the container gets an empty network namespace with
only loopback (PLAN.md explains why). 140 unit tests (run anywhere) + 52 integration tests (Linux + root), 29
mutation checks. Server steps and timeline: `SERVER_RUN.md`.

## Read this first: it is NOT a security boundary

minibox runs everything as real root and does none of the hardening a real runtime does:

- **No user namespace.** Root in the container is root on the host (uid 0 in the same user namespace; a test checks
  this so the sentence stays true).
- **No capability dropping.** The container keeps every capability, including `CAP_SYS_ADMIN` (it can mount
  filesystems), `CAP_SYS_MODULE` (load kernel modules), `CAP_MKNOD` (create a device node for the host's disk and
  read it), `CAP_SYS_PTRACE`.
- **No seccomp filter, no AppArmor/SELinux profile.** Every syscall is allowed.
- **No cgroup namespace**, and `/sys` is not mounted, but nothing stops the container from mounting it itself.

So a process inside can get out without any exploit (e.g. `mknod` the host disk, mount it). The isolation here is
the "namespaces + pivot_root + cgroups" part of a container: enough to understand what docker does, and to keep
honest programs from seeing or hurting each other. It is not protection against a hostile program. Run only code
you would run as root on the host anyway.

## How a container starts (three processes)

```
minibox (host)        creates the cgroup leaf and the overlay dirs, unshare(CLONE_NEWPID), fork INIT,
  |                   writes INIT's pid into cgroup.procs, then lets INIT continue (pipe), forwards signals,
  |                   waits, then: cgroup.kill + wait empty, stats, rmdir cgroup, delete the overlay dirs
  +- INIT  (PID 1)    unshare(mount, UTS, IPC, net), sethostname, lo up, mount plan, pivot_root,
       |              fork CMD, then reap EVERY child and forward signals until CMD exits
       +- CMD (PID 2) reset signal dispositions, chdir(workdir), execvpe(command, clean env)
```

- `unshare(CLONE_NEWPID)` does not move the caller into the new PID namespace; only its next child is created there,
  as PID 1. That is why INIT is a fork and not the host process itself.
- INIT joins the cgroup BEFORE it forks anything. A pipe holds it until the host has written its pid into
  `cgroup.procs`; children inherit the cgroup, so no process of the container ever runs unlimited. Without the pipe
  this is a real race (mutation M13 below: red in 3 of 3 runs once the test repeats 10 containers).
- **PID 1 is special.** The kernel gives PID 1 of a namespace no default signal actions: a signal it has no handler
  for is dropped (only SIGKILL/SIGSTOP from an ancestor namespace get through). A shell or a server running as PID 1
  therefore ignores `docker stop`'s SIGTERM. INIT installs handlers for TERM, INT, HUP, QUIT, USR1, USR2 and passes
  them to CMD; the host process passes them to INIT. And every orphan in the namespace is re-parented to PID 1, so
  INIT calls `waitpid(-1)` in a loop; otherwise they stay zombies. This is what `docker run --init` (tini) adds.
- When CMD exits, INIT exits with its code and the kernel SIGKILLs everything left in the namespace: the container
  lives exactly as long as its command.
- Exit codes like docker: the command's code; `128+N` if killed by signal N (OOM kill -> 137); 125 if minibox
  could not set up the container; 126 not executable; 127 not found.
- CMD resets SIGPIPE to default before exec: Python ignores SIGPIPE, and an ignored signal survives `exec`, so
  `yes | head -1` would otherwise print a write error instead of ending quietly (test + mutation M8).
- The environment is NOT inherited: `PATH`, `HOME`, `HOSTNAME`, `TERM` and `--env K=V` only (test + M9).

## The filesystem: a plan, then pivot_root

`mounts.build_plan` returns the steps as data (unit tested for order and flags); `apply_plan` runs them inside
INIT's new mount namespace:

| # | Step | Why |
|---|---|---|
| 1 | `mount(NULL, "/", MS_REC\|MS_PRIVATE)` | `/` on systemd hosts is `shared`: without this every mount below would ALSO appear on the host (mutation M4 shows exactly that: 10 mounts leaked into the host and had to be unmounted by hand), and `pivot_root` refuses shared mounts |
| 2 | overlay on `<state>/merged` (`lowerdir=image,upperdir,workdir`), or with `--no-overlay` a bind mount of the rootfs onto itself | `pivot_root` needs the new root to be a mount point |
| 3 | `proc` on `new_root/proc` (nosuid, nodev, noexec) | a fresh procfs shows only the new PID namespace; the image's empty `/proc` would show nothing (M3: 12 tests red) |
| 4 | tmpfs on `/dev`, then `mknod` null, zero, full, random, urandom, tty; symlinks fd, stdin, stdout, stderr, ptmx; a new-instance devpts; tmpfs `/dev/shm` | the same small set runc creates; the host's disks are not there |
| 5 | `pivot_root(new_root, new_root/.oldroot)`, `chdir("/")`, `umount2("/.oldroot", MNT_DETACH)`, `rmdir` | after this the host's tree is not mounted anywhere in the namespace (M2: the mount-list test sees `/.oldroot`) |

### Why pivot_root and not chroot: the chroot escape

`chroot(dir)` changes one thing: where THIS process's path lookups start. The host's root is still mounted in the
namespace, and the kernel only stops `..` at the process's root if the walk actually passes through it. A root
process (with `CAP_SYS_CHROOT`, which a container keeps here) escapes like this:

```
mkdir("x"); chroot("x");          // new root is /x, but the cwd is still / -- OUTSIDE the new root
chdir("..") x 64                  // nothing stops the walk: the cwd climbs to the HOST's real /
chroot(".")                       // make that the root: escaped
```

`pivot_root` swaps the root MOUNT of the whole namespace, and after the old root is detached there is no host tree
left to climb into: `..` at the top of the namespace's root mount stays where it is.

Both are tested, by running exactly that escape in a forked child after the real setup code
(`test_pivot_root_cannot_be_escaped`, `test_chroot_alone_can_be_escaped`). The second is the control: the same
escape against chroot DOES reach a marker file that exists only on the host. Mutation M1 (pivot_root replaced by
chroot) turns the first red. Note: pivot_root stops THIS path out; with all capabilities kept, a root process can
still get out other ways (see the security section).

## Stage 2: cgroup v2 limits

One leaf per container: `/sys/fs/cgroup/minibox/<name>/`. The parent enables `+cpu +memory +pids` in its
`cgroup.subtree_control` (cgroup v2's "no internal processes" rule: limits live in leaves). minibox refuses to run
if the root cgroup does not already delegate those controllers, instead of changing the host's root cgroup.

| Flag | Written | Proven by |
|---|---|---|
| `--memory 64M` | `memory.max = 67108864` AND `memory.swap.max = 0` | a shell string doubled to 128 MiB is OOM-killed: exit 137, `oom_kill 1` in memory.events, `memory.peak` = the limit. A 16 MiB one survives. Without the swap line the hog survives by swapping (the server has 4 GB swap; M15) |
| `--pids 32` | `pids.max = 32` | 100 background `sleep`s and a real fork bomb both stop at `pids.peak` 32 with refused forks in pids.events; the host can still start processes during the bomb |
| `--cpus 0.5` | `cpu.max = 50000 100000` (quota and period in microseconds) | a busy loop gets 0.50 of a CPU, throttled in every period |

At exit minibox writes `cgroup.kill`, waits for `populated 0` in cgroup.events, reads the counters (and the limits
BACK from the kernel) into `--stats-file`, then `rmdir`s the leaf (and the parent when no other container uses it).
The tables below come from those stats files.

## Measured on portfolio-a2

Conditions: Oracle Ampere A1 VM, 2 vCPUs (Neoverse-N1), 12 GB RAM + 4 GB swap, Ubuntu 24.04, kernel 7.0.0, Python
3.12.3, image alpine:3.20 (arm64, pulled by minibox), nothing else heavy running (load average 0.18 before). Measured
by `bench/limits.py`; every row is generated from the raw files, nothing typed.

What the numbers say:

- **Starting an empty container costs about 18 ms** inside minibox (cgroup + overlay dirs + namespaces + mounts +
  pivot_root + exec + cleanup); about 105 ms including starting the Python interpreter for `python3 -m minibox`.
- **pids.max is a hard wall.** Both the 100-sleeper loop and the fork bomb reached exactly 32 processes and no more.
  busybox `sh` gives up when `fork()` fails, so the bomb ends by itself in about 30 ms with exit code 2. The bomb's
  "forks refused" count varies (29-64) because it depends on how many copies were trying at that moment.
- **memory.max is enforced by the kernel's OOM killer inside the cgroup.** All 3 hogs were killed (exit 137,
  `oom_kill` 1) at a peak of exactly 64.0 MiB; `memory.events max` (times the limit was hit) was 37. The host was
  not affected: the kernel log shows `constraint=CONSTRAINT_MEMCG` (an OOM of THIS cgroup, not of the machine).
- **cpu.max is exact for a single busy loop.** 0.5 CPU gave a share of 0.501 and 0.25 gave 0.252, throttled in 50 of
  about 50 periods (100 ms each over 5 s); throttled time 2.49 s and 3.75 s of the 5 s. With `1.0` or no limit the
  loop used 0.998 of a CPU and was never throttled -- one loop cannot use more than one CPU, so the 1.0 quota is never
  reached.

<!-- MEASURED:START -->
<!-- generated by bench/limits.py --render from bench/reference-results; do not edit -->

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

<!-- MEASURED:END -->

## Stage 3: images, layers and the overlay root

**Pull** (`minibox/registry.py`, stdlib `urllib` + `hashlib` + `tarfile`): GET the manifest -> 401 with a
`WWW-Authenticate: Bearer realm=...,service=...,scope=...` challenge -> anonymous token from that realm -> manifest
again. Docker Hub returns an image INDEX (one manifest per platform); minibox picks `linux/arm64` (or `linux/amd64`)
and fetches that manifest BY DIGEST. Then the config blob and each layer blob. Verified before anything is applied:

| Check | Why |
|---|---|
| a manifest fetched by digest must hash to that digest; a manifest fetched by tag must match the registry's `Docker-Content-Digest` header | content addressing: the digest IS the name |
| the config blob hashes to the manifest's `config.digest` | the config lists the layers' `diff_ids` |
| every layer blob (compressed) hashes to its digest, and its size matches | a corrupted or swapped download is refused |
| every layer, DECOMPRESSED, hashes to the config's `rootfs.diff_ids[i]` | ties the content to the config, not only the transport |

A blob that fails is deleted (never cached and reused). The token is sent with `add_unredirected_header`, so when a
blob GET is redirected to the CDN, urllib does not forward the token there (unit test drives `urllib_fetch` through
urllib's redirect logic; M29). Tested against a fake registry in the unit tests and against Docker Hub once in the
integration run (alpine:3.20: 1 layer, 4092319 bytes compressed, 517 tar entries, about 4 s).

Trust note: a TAG is a mutable name; for a tag the chain starts at what Docker Hub returns over TLS. Pulling by
digest (`alpine@sha256:...`) gives end-to-end verification.

**Layers and whiteouts** (`minibox/image.py`): layers are applied in order into one directory. A layer marks a
deletion with `dir/.wh.name` (delete `name`) or `dir/.wh..wh..opq` (opaque: delete everything the LOWER layers had in
`dir`). Per the OCI spec a whiteout only applies to lower layers, so each layer is applied in two passes: whiteouts
first, then its own files (M25: one pass in the other order lets a layer delete its own files). Safety: names with
`..` are refused, a path whose parent resolves outside the rootfs through a symlink is refused, extraction uses
numeric uid/gid, and tarfile's own `tar` filter is used for its checks but the image's real modes are restored
(otherwise the 1777 `/tmp` becomes 0755, M28).

**Overlay root** (`minibox/mounts.py`): the flattened image is the read-only `lowerdir`; each container gets
`upper/`, `work/`, `merged/` under `--state-dir`. The overlay is mounted inside INIT's mount namespace, so it
disappears with the container, and minibox then deletes the dirs: every write is gone. Deleting a file inside the
container creates overlayfs's OWN whiteout in `upper/` (a 0/0 character device -- a different format from the layer
tar's `.wh.` files; tested). `--no-overlay` writes straight into `--rootfs` instead.

## Mutation checks (2026-11-21, on portfolio-a2)

Each rule was broken on purpose IN THE COPY ON THE SERVER (never in the repo), the relevant tests were run as root,
and the clean tree was shipped again. A check passes when at least one test turns red. Counts are failed tests
("errors" = the cleanup fixture found containers or mounts left behind by the broken code and removed them).

| # | Deliberate break | Tests run | Failed |
|---|---|---|---|
| M1 | pivot_root replaced by chroot | isolation (36) | 1 (the escape test) |
| M2 | old root not detached after pivot_root | isolation | 1 |
| M3 | /proc not remounted | isolation | 12 |
| M4 | mounts not made private first | 2 isolation tests | 2 + 2 errors (pivot_root refuses, 10 mounts leaked into the host and were unmounted by hand) |
| M5 | INIT waits only for the command (no zombie reaping) | isolation | 1 |
| M6 | INIT does not forward signals | isolation | 2 + 2 errors |
| M7 | the host process does not forward signals | isolation | 2 + 3 errors |
| M8 | SIGPIPE left ignored in the command | isolation | 1 |
| M9 | host environment copied into the container | isolation | 1 |
| M10 | no IPC namespace | isolation | 2 |
| M11 | death by signal not mapped to 128+N | isolation | 3 |
| M12 | the container never joins its cgroup | limits (9) | 5 |
| M13 | INIT does not wait for the cgroup join (pipe removed on both sides) | limits + isolation (45) | 4, 2, 2 in three runs |
| M14 | memory.max not written | limits | 2 |
| M15 | memory.swap.max not written | limits | 2 |
| M16 | pids.max not written | limits | 3 |
| M17 | cpu.max not written | limits | 2 |
| M18 | cleanup skips cgroup.kill | limits + isolation | **0 (not caught)** |
| M19 | overlay replaced by a bind mount of the image | overlay (5, on a copy of the image) | 4 |
| M20 | layer digest not checked | unit image + registry (58) | 2 |
| M21 | layer diff_id not checked | unit image + registry | 1 |
| M22 | config digest not checked | unit image + registry | 1 |
| M23 | whiteouts ignored (extracted as plain files) | unit + overlay (64) | 5 |
| M24 | opaque whiteouts ignored | unit image + registry | 3 |
| M25 | whiteouts applied after the layer's own files | unit image + registry | 4 |
| M26 | `..` in tar member names not refused | unit image + registry | 4 |
| M27 | symlink check on parent directories removed | unit image + registry | 2 |
| M28 | tarfile's `tar` filter used as is (modes stripped) | unit image + registry + `test_minimal_dev` | 1 |
| M29 | registry token also sent on redirects | unit image + registry | 1 |

28 of 29 caught. What the table does NOT show, honestly:

- **M18 is not caught, and cannot be with this design.** INIT is PID 1 of the container's PID namespace; when it
  exits the kernel kills every process in that namespace, and every process in the cgroup is in that namespace. So
  the cgroup is already empty when cleanup runs, and `cgroup.kill` never has anything to kill (the wait for
  `populated 0` is still there in the mutation). It stays as a safety net for a future change (e.g. `exec` into a
  running container would put a process into the cgroup that is NOT a child of INIT).
- **M13 is a race.** Before the cgroup test was made to start 10 containers, one of 4 runs was fully green.
- **M26** is caught only by the unit test of the name check; at apply time tarfile's own filter would also refuse
  `../x`, so this is two lines of defense, not one.
- **The fork bomb test was never run against mutated code** (it is deselected in every mutation run): without the
  limit it would take the server down. During one early mutation run (M13, before that rule) it DID run with the
  container outside its cgroup; the server's own per-session limit stopped it. Details in `SERVER_RUN.md`.
- Mutations of the UTS namespace flag were not run: without it `sethostname` would rename the real server.

Before every mutation the clean tree was shipped again. After the mutation runs the clean tree passed the full suite
(192/192: 140 unit + 52 integration, 18:20 UTC); code and tests did not change after that run.

## NOT implemented (honest list)

- Security hardening: user namespaces (rootless), capability dropping, seccomp, AppArmor/SELinux, read-only rootfs,
  `no_new_privs`, masking `/proc/kcore` and friends. See the first section: this is NOT a security boundary.
- Networking beyond loopback (stage 4: veth pair, bridge, NAT, port publishing). Not done, see PLAN.md.
- A cgroup namespace (the container sees its full cgroup path) and `/sys`.
- If minibox itself is SIGKILLed, nobody cleans up: the container keeps running and its cgroup and state dir stay.
  There is no `minibox gc`/`ps`/`stop`/`exec` -- one foreground command per container.
- No TTY allocation (`-t`), no pty inside. When stdin is a terminal, CMD takes its own process group and the
  terminal's foreground, so Ctrl-C reaches only the command; that code path is written but NOT tested (the tests run
  without a terminal).
- No IO or cpuset limits, no `memory.high` soft limit, no OOM score tuning.
- Image config is downloaded but not used: the image's `Env`, `Cmd`, `WorkingDir` and `User` are ignored (you pass
  the command). Only gzip and plain tar layers (no zstd). No image cache across pulls (each pull is complete), no
  `push`, no build.
- Layers are flattened into one directory per image (simple, one lowerdir) instead of one overlay lowerdir per layer
  (what docker does, so layers are shared between images on disk).
- INIT does not check what it read from the sync pipe: if the host process died before writing to it, INIT would get
  end-of-file and carry on outside its cgroup. Found while writing the interview bank, after the server run; not
  fixed, so the tested code stays the code described here.
- Two containers starting at the exact moment the last one is removing the shared parent cgroup can race (the
  second gets ENOENT and exits 125).

## Run it

```
python -m pytest tests/unit                       # anywhere (Windows too): 140 tests, 5 skip on Windows (symlinks, POSIX modes)
sudo python3 -m minibox pull alpine:3.20 --dest ~/h16/images/alpine
sudo MINIBOX_TEST_ROOTFS=$HOME/h16/images/alpine/rootfs python3 -m pytest      # Linux + root: + 52 integration tests
sudo python3 bench/limits.py --rootfs ... --state-dir ... --out bench/reference-results/<label>
python3 bench/limits.py --render bench/reference-results/<label> --update-readme README.md
```

Options of `run`: `--rootfs` (required), `--hostname`, `--memory`, `--pids`, `--cpus`, `--name`, `--no-overlay`,
`--state-dir` (default `/run/minibox`), `--stats-file`, `--env/-e K=V`, `--workdir/-w`, then `--` and the command.

## Files

| File | Purpose |
|---|---|
| `minibox/cli.py` | argument parsing and validation, `run` / `pull` |
| `minibox/container.py` | the three processes: host side, INIT (PID 1), CMD; signals, reaping, exit codes, cleanup |
| `minibox/mounts.py` | the mount plan (data), applying it, `enter_root` (pivot_root; chroot only for the escape test) |
| `minibox/cgroups.py` | cgroup v2 value parsing/formatting, `Limits.writes()`, the per-container `Cgroup` |
| `minibox/image.py` | digests, tar member checks, whiteouts, `apply_layer` |
| `minibox/registry.py` | references, bearer token, index -> platform manifest, blobs, verification, `pull` |
| `minibox/libc.py` | ctypes: mount, umount2, pivot_root |
| `bench/limits.py` | the measurements above, raw JSON + generated tables |
| `tests/unit/` | 140 tests, no root, no Linux needed (fake cgroup dirs, fixture layer tars, a fake registry) |
| `tests/integration/` | 52 tests, real namespaces/mounts/cgroups; a fixture kills and removes anything a failed test left |
