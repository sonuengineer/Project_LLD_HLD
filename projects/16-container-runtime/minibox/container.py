"""Running one container: three processes.

    minibox (host)        creates the cgroup and overlay dirs, unshare(CLONE_NEWPID), forks INIT,
      |                   moves INIT into the cgroup, forwards signals, waits, cleans up
      +- INIT  (PID 1)    unshare(mount, UTS, IPC, net), hostname, mounts, pivot_root, forks CMD,
           |              then reaps every zombie and forwards signals until CMD exits
           +- CMD (PID 2) execvp(the user's command)

unshare(CLONE_NEWPID) does not move the caller: only its NEXT child is created in the new PID
namespace, and that child is PID 1 there. That is why INIT is a separate process.

Exit codes follow docker: the command's own code; 128+N if it was killed by signal N;
125 if minibox itself failed to set up the container; 126 not executable; 127 not found.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import socket
import struct
import sys
import time
from dataclasses import dataclass, field

from . import mounts
from .cgroups import Cgroup, Limits

EXIT_SETUP_FAILED = 125
EXIT_NOT_EXECUTABLE = 126
EXIT_NOT_FOUND = 127
FORWARDED_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT,
                     signal.SIGUSR1, signal.SIGUSR2) if hasattr(signal, "SIGUSR1") else ()
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


@dataclass
class Config:
    rootfs: str
    command: list[str]
    hostname: str = "minibox"
    limits: Limits = field(default_factory=Limits)
    overlay: bool = True
    state_dir: str = "/run/minibox"
    name: str | None = None
    stats_file: str | None = None
    env: list[str] = field(default_factory=list)
    workdir: str = "/"
    # Internals, switched only by tests to prove what each rule protects against:
    use_pivot_root: bool = True
    reap_zombies: bool = True
    forward_signals: bool = True


def new_name() -> str:
    return "mb-" + secrets.token_hex(4)


def exit_code_from_status(status: int) -> int:
    """os.waitpid status -> shell-style exit code (128+N for death by signal N)."""
    code = os.waitstatus_to_exitcode(status)
    return 128 - code if code < 0 else code


def container_env(cfg: Config) -> dict[str, str]:
    env = {"PATH": DEFAULT_PATH, "HOME": "/root", "HOSTNAME": cfg.hostname, "TERM": os.environ.get("TERM", "xterm")}
    for item in cfg.env:
        k, sep, v = item.partition("=")
        if not sep or not k:
            raise ValueError(f"--env needs KEY=VALUE, got {item!r}")
        env[k] = v
    return env


# ---------------------------------------------------------------------------------------------- host

def run(cfg: Config) -> int:
    name = cfg.name or new_name()
    rootfs = os.path.abspath(cfg.rootfs)
    if not os.path.isdir(rootfs):
        print(f"minibox: rootfs {rootfs} is not a directory", file=sys.stderr)
        return EXIT_SETUP_FAILED
    env = container_env(cfg)

    overlay = None
    state = os.path.join(os.path.abspath(cfg.state_dir), name)
    cgroup = Cgroup(name)
    started = time.monotonic()
    exit_code = EXIT_SETUP_FAILED
    init_pid = 0
    owned = {"cgroup": False, "state": False}     # never clean up another container's cgroup/dirs
    try:
        if cfg.overlay:
            overlay = mounts.OverlayDirs(lower=rootfs, upper=os.path.join(state, "upper"),
                                         work=os.path.join(state, "work"), merged=os.path.join(state, "merged"))
            os.makedirs(state, mode=0o700)          # fails if the name is already in use
            owned["state"] = True
            for d in (overlay.upper, overlay.work, overlay.merged):
                os.mkdir(d, 0o755)
        plan = mounts.build_plan(rootfs, overlay)
        cgroup.create(cfg.limits)                   # fails if the name is already in use
        owned["cgroup"] = True

        ready_r, ready_w = os.pipe()
        os.unshare(os.CLONE_NEWPID)
        init_pid = os.fork()
        if init_pid == 0:                           # ---- INIT, PID 1 in the new namespace
            os.close(ready_w)
            os.read(ready_r, 1)                     # wait until the host put us into the cgroup
            os.close(ready_r)
            code = EXIT_SETUP_FAILED
            try:
                code = init_main(cfg, plan, env)
            except BaseException as e:              # never return into the host's code path
                print(f"minibox: container setup failed: {e}", file=sys.stderr)
            finally:
                os._exit(code)
        os.close(ready_r)
        cgroup.add_pid(init_pid)                    # before INIT can fork: every child is limited too
        os.write(ready_w, b"x")
        os.close(ready_w)

        if cfg.forward_signals:
            def forward(sig, _frame):
                try:
                    os.kill(init_pid, sig)
                except ProcessLookupError:
                    pass
            for sig in FORWARDED_SIGNALS:
                signal.signal(sig, forward)
        _, status = os.waitpid(init_pid, 0)
        exit_code = exit_code_from_status(status)
        return exit_code
    except (OSError, RuntimeError, ValueError) as e:
        if init_pid:                                # e.g. joining the cgroup failed: INIT still waits
            try:
                os.kill(init_pid, signal.SIGKILL)
                os.waitpid(init_pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        print(f"minibox: {e}", file=sys.stderr)
        return EXIT_SETUP_FAILED
    finally:
        if init_pid:
            for sig in FORWARDED_SIGNALS:
                signal.signal(sig, signal.SIG_DFL)
        cleanup(cfg, cgroup if owned["cgroup"] else None, state if owned["state"] else None, started, exit_code)


def cleanup(cfg: Config, cgroup: Cgroup | None, state: str | None, started: float, exit_code: int) -> None:
    if cgroup is not None and os.path.isdir(cgroup.path):
        cgroup.kill()        # normally empty already: PID 1 exiting kills its whole namespace
        if cfg.stats_file:
            stats = cgroup.stats()
            stats.update(exit_code=exit_code, wall_s=round(time.monotonic() - started, 3))
            with open(cfg.stats_file, "w") as f:
                json.dump(stats, f, indent=1, sort_keys=True)
        cgroup.remove()
    if state and os.path.isdir(state):
        # The overlay itself lived only in INIT's mount namespace, which died with INIT, so these are
        # plain directories now. Deleting upper is what makes the container's changes disappear.
        merged = os.path.join(state, "merged")
        if os.path.ismount(merged):  # pragma: no cover - only if someone mounted it in the host ns
            raise RuntimeError(f"{merged} is still mounted in the host namespace")
        shutil.rmtree(state)


# ---------------------------------------------------------------------------------------------- init

def bring_up_loopback() -> None:
    """ifconfig lo up, with SIOCGIFFLAGS / SIOCSIFFLAGS on a plain socket (no iproute2 needed)."""
    import fcntl  # Linux only; imported here so the module still imports on Windows for unit tests

    siocgifflags, siocsifflags, iff_up = 0x8913, 0x8914, 0x1
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        ifreq = struct.pack("16sH22x", b"lo", 0)
        flags = struct.unpack("16sH22x", fcntl.ioctl(s.fileno(), siocgifflags, ifreq))[1]
        fcntl.ioctl(s.fileno(), siocsifflags, struct.pack("16sH22x", b"lo", flags | iff_up))


def setup_container(cfg: Config, plan: mounts.Plan) -> None:
    """Everything between 'new namespaces' and 'exec', in the order it must happen."""
    os.unshare(os.CLONE_NEWNS | os.CLONE_NEWUTS | os.CLONE_NEWIPC | os.CLONE_NEWNET)
    socket.sethostname(cfg.hostname)
    bring_up_loopback()
    mounts.apply_plan(plan)
    mounts.enter_root(plan.new_root, use_pivot_root=cfg.use_pivot_root)


def init_main(cfg: Config, plan: mounts.Plan, env: dict[str, str]) -> int:
    setup_container(cfg, plan)

    cmd_pid = os.fork()
    if cmd_pid == 0:                                # ---- CMD, PID 2
        try:
            # Python ignores SIGPIPE and installs a SIGINT handler; an exec'd program must start
            # with default dispositions (ignored signals survive exec, handlers do not).
            if os.isatty(0):
                # Own process group in the terminal's foreground: Ctrl-C then reaches only the
                # command (as when it runs without minibox), not minibox and INIT as well.
                signal.signal(signal.SIGTTOU, signal.SIG_IGN)
                os.setpgid(0, 0)
                os.tcsetpgrp(0, os.getpgrp())
            for sig in (signal.SIGPIPE, signal.SIGINT, signal.SIGTTOU, *FORWARDED_SIGNALS):
                signal.signal(sig, signal.SIG_DFL)
            try:
                os.chdir(cfg.workdir)
            except OSError as e:
                print(f"minibox: workdir {cfg.workdir}: {e.strerror}", file=sys.stderr)
                os._exit(EXIT_SETUP_FAILED)
            os.execvpe(cfg.command[0], cfg.command, env)
        except FileNotFoundError:
            print(f"minibox: {cfg.command[0]}: command not found", file=sys.stderr)
            os._exit(EXIT_NOT_FOUND)
        except PermissionError:
            print(f"minibox: {cfg.command[0]}: permission denied", file=sys.stderr)
            os._exit(EXIT_NOT_EXECUTABLE)
        except BaseException as e:
            print(f"minibox: exec failed: {e}", file=sys.stderr)
            os._exit(EXIT_SETUP_FAILED)

    # PID 1 of a namespace gets NO default signal actions: a signal it has no handler for is simply
    # dropped (only SIGKILL / SIGSTOP from an ancestor namespace get through). So without these
    # handlers 'docker stop'-style SIGTERM would do nothing. We pass it on to the command.
    if cfg.forward_signals:
        def forward(sig, _frame):
            try:
                os.kill(cmd_pid, sig)
            except ProcessLookupError:
                pass
        for sig in FORWARDED_SIGNALS:
            signal.signal(sig, forward)

    # Every orphan in the namespace is re-parented to PID 1. If PID 1 never wait()s for them they
    # stay zombies (entries in the process table) until the namespace ends.
    while True:
        try:
            pid, status = os.waitpid(-1 if cfg.reap_zombies else cmd_pid, 0)
        except ChildProcessError:
            return EXIT_SETUP_FAILED
        if pid == cmd_pid:
            # Returning makes PID 1 exit, and the kernel then SIGKILLs everything left in the
            # namespace -- the same as docker: the container lives exactly as long as its command.
            return exit_code_from_status(status)
