# H16 (A1 "Build your own Docker") -- minibox: plan

Status (2026-11-21): stages 1-3 DONE and tested on `portfolio-a2` (Linux, root); stage 2 limits measured there;
stage 4 (networking beyond loopback) NOT done, see "Stage 4 decision". Details and numbers in README.md, server steps
in SERVER_RUN.md.

## Why this project

Every earlier project here ran INSIDE containers (docker compose for Redis, Postgres, NATS). This one builds the thing
underneath: what `docker run` actually asks the kernel for. The point is to be able to explain, from code that was
written and tested by hand, what a container is: a normal process with its own namespaces, a different root
filesystem, and cgroup limits -- and what it is NOT (a security boundary, when run like this).

## Decisions (one recommendation each)

- **Python 3.12, zero third-party runtime dependencies.** `os.unshare`, `os.fork`, `os.execvpe`, `os.chroot`,
  `os.mknod` and `socket.sethostname` are all in the stdlib; only mount(2), umount2(2) and pivot_root(2) go through
  `ctypes` on libc (`minibox/libc.py`, about 60 lines). pytest is the only dev dependency. Go or C would be the
  production choice (runc is Go); Python keeps every syscall visible and the code short.
  - Changed from the brief: `sethostname` uses the stdlib's `socket.sethostname` instead of ctypes -- it is the same
    syscall and one less wrapper.
- **Three processes per container: host -> INIT (PID 1) -> CMD (PID 2).** `unshare(CLONE_NEWPID)` only affects the
  caller's NEXT child, so INIT must be a fork. INIT is our own Python code, not the user's command, because PID 1 has
  two duties a normal program does not do: reap orphans and pass on signals (PID 1 gets no default signal actions).
  This is what `docker run --init` / tini add. Recommended over "exec the command as PID 1" because a shell or a web
  server as PID 1 silently ignores SIGTERM and leaves zombies.
- **pivot_root, not chroot.** chroot changes one process's idea of `/` while the host tree stays mounted in the
  namespace; a root process walks back out. pivot_root + detaching the old root removes the host tree from the
  namespace. Both are tested, including the escape itself (README).
- **The mount plan is data.** `mounts.build_plan` returns a list of steps (Mount / Mkdir / Mknod / Symlink);
  `apply_plan` executes them. The order and every flag are unit tested on any OS; the effect is integration tested.
- **Network: a new, empty network namespace with only loopback (brought up with an ioctl).** Isolation by default;
  no host network sharing. Stage 4 would add a veth pair.
- **cgroup v2 through files, one leaf per container under `/sys/fs/cgroup/minibox/`.** No systemd, no libcgroup.
  The leaf is joined BEFORE INIT forks anything (a pipe makes INIT wait), so no process ever runs unlimited.
  `memory.swap.max = 0` is always written with `--memory` (the server has 4 GB swap; without it "64M" is not 64M).
  Cleanup writes `cgroup.kill` and waits for `populated 0` before `rmdir`.
- **Images: pull from Docker Hub with urllib, verify everything, flatten the layers into one directory, use it as
  the overlay's read-only lowerdir.** Each container gets its own upperdir, deleted after exit. Flattening (instead of
  one lowerdir per layer) means whiteouts are applied once, at pull time, in the OCI format (`.wh.` files), and the
  overlay only ever sees one lower layer. The registry pull fit in stdlib (about 250 lines), so the alpine minirootfs
  fallback was not needed.
- **Never trust the network for content: blobs are content addressed.** Manifest fetched by digest, config, every
  layer (compressed) and every layer's `diff_id` (uncompressed) are checked before ANY layer is applied. A blob that
  fails is deleted, not cached. The registry token is sent as an "unredirected" header, so it never goes to the CDN a
  blob download redirects to.

## Stages

| Stage | What | Proven by |
|---|---|---|
| 1 | PID, UTS, mount, IPC, net namespaces; pivot_root into a rootfs; fresh /proc; minimal /dev; INIT as PID 1 reaping zombies and forwarding signals; exit codes like docker (code, 128+N, 125/126/127) | `tests/integration/test_isolation.py`, `tests/unit/test_mounts.py`, `tests/unit/test_cli.py` |
| 2 | cgroup v2 memory.max (+ swap 0), pids.max, cpu.max; per-container cgroup created and removed; stats read back | `tests/integration/test_limits.py`, `tests/unit/test_cgroups.py`, `bench/limits.py` (measured) |
| 3 | overlayfs root (image read-only, per-container upper discarded); `minibox pull` from Docker Hub with anonymous token, digest + diff_id verification, whiteouts | `tests/integration/test_overlay.py`, `tests/unit/test_image.py`, `tests/unit/test_registry.py` |
| 4 | network namespace + veth + bridge + NAT | NOT done (see below) |

## Stage 4 decision (networking): not done

Checked on `portfolio-a2` (read only): Docker is installed there and owns the FORWARD chain (policy DROP, then
`DOCKER-USER`, `DOCKER-FORWARD`, then a REJECT), and the nat table has Docker's MASQUERADE rule. A bridge + NAT for
minibox would need new FORWARD and POSTROUTING rules inserted into chains Docker manages. They could be made temporary
(not saved) and tagged, but they would sit in the same chains as Docker's rules on a server that is used for other
things, and the brief says to leave networking out rather than risk that. So: the container gets its own network
namespace with only `lo` (up, `ping 127.0.0.1` works, tested), and nothing else. A veth pair WITHOUT NAT (host <->
container on a private /30, no iptables at all) would be possible and is the first step if this is picked up again.

## Not in scope

User namespaces (rootless), seccomp, capability dropping, AppArmor/SELinux profiles, cgroup namespaces, image build,
registry push, an OCI runtime-spec `config.json`, `exec` into a running container, TTY allocation (`-t`).
