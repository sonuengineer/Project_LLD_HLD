"""Command line: `python -m minibox run ...` and `python -m minibox pull ...`.

    sudo python3 -m minibox run --rootfs DIR [--hostname box1] [--memory 64M] [--pids 32] [--cpus 0.5]
                                [--name NAME] [--no-overlay] [--state-dir DIR] [--stats-file F]
                                [--env K=V ...] [--workdir /] [--net none|veth] -- CMD [ARGS...]
    python3 -m minibox pull alpine:3.20 --dest DIR [--platform linux/arm64]
"""
from __future__ import annotations

import argparse
import os
import re
import sys

from .cgroups import Limits, parse_size

HOSTNAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")


def _size(text: str) -> int:
    try:
        return parse_size(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e)) from None


def _cpus(text: str) -> float:
    try:
        v = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"bad cpus {text!r}") from None
    if not 0 < v <= 1024:
        raise argparse.ArgumentTypeError("cpus must be > 0")
    if round(v * 100_000) < 1_000:
        raise argparse.ArgumentTypeError("cpus must be >= 0.01 (the kernel's minimum quota is 1 ms per 100 ms)")
    return v


def _pids(text: str) -> int:
    try:
        v = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"bad pids {text!r}") from None
    if v < 1:
        raise argparse.ArgumentTypeError("pids must be >= 1")
    return v


def _hostname(text: str) -> str:
    if len(text) > 64 or not HOSTNAME_RE.match(text):
        raise argparse.ArgumentTypeError(f"bad hostname {text!r}")
    return text


def _name(text: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", text):
        raise argparse.ArgumentTypeError(f"bad name {text!r} (letters, digits, _ . -)")
    return text


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="minibox", description="a minimal container runtime (learning project)")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run a command in a new container")
    r.add_argument("--rootfs", required=True, help="root filesystem directory (an image's rootfs)")
    r.add_argument("--hostname", type=_hostname, default="minibox")
    r.add_argument("--memory", type=_size, help="memory.max, e.g. 64M (swap is disabled for the container)")
    r.add_argument("--pids", type=_pids, help="pids.max: max number of processes and threads")
    r.add_argument("--cpus", type=_cpus, help="cpu.max as CPUs, e.g. 0.5 = 50 ms per 100 ms period")
    r.add_argument("--name", type=_name, help="container name (cgroup and state dir); random if omitted")
    r.add_argument("--no-overlay", dest="overlay", action="store_false",
                   help="write directly into --rootfs instead of a throwaway overlay upper dir")
    r.add_argument("--state-dir", default="/run/minibox", help="where overlay upper/work/merged dirs live")
    r.add_argument("--stats-file", help="write limits read back + cgroup counters as JSON at exit")
    r.add_argument("--env", "-e", action="append", default=[], metavar="KEY=VALUE")
    r.add_argument("--workdir", "-w", default="/")
    r.add_argument("--net", choices=("none", "veth"), default="none",
                   help="none: loopback only (default); veth: also eth0 on a private /30 to the host, no NAT")
    r.add_argument("command", nargs=argparse.REMAINDER, help="-- CMD [ARGS...]")

    pl = sub.add_parser("pull", help="pull an image from a registry into DIR/rootfs")
    pl.add_argument("reference", help="e.g. alpine:3.20, busybox, ghcr.io/owner/repo:tag, repo@sha256:...")
    pl.add_argument("--dest", required=True)
    pl.add_argument("--platform", help="os/arch[/variant], default: this machine (e.g. linux/arm64)")
    return p


def parse_args(argv: list[str]):
    args = build_parser().parse_args(argv)
    if args.cmd == "run":
        cmd = args.command
        if cmd and cmd[0] == "--":
            cmd = cmd[1:]
        if not cmd:
            build_parser().error("run: missing command (put it after --)")
        args.command = cmd
        args.limits = Limits(memory=args.memory, pids=args.pids, cpus=args.cpus)
    if args.cmd == "pull" and args.platform:
        parts = args.platform.split("/")
        if len(parts) not in (2, 3):
            build_parser().error("--platform must be os/arch or os/arch/variant")
        args.platform = (parts[0], parts[1], parts[2] if len(parts) == 3 else None)
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.cmd == "pull":
        from . import registry
        registry.pull(args.reference, args.dest, platform_=args.platform)
        return 0
    if sys.platform != "linux":
        print("minibox: run needs Linux", file=sys.stderr)
        return 125
    if os.geteuid() != 0:
        print("minibox: run needs root (no user namespace support), use sudo", file=sys.stderr)
        return 125
    from .container import Config, run
    cfg = Config(rootfs=args.rootfs, command=args.command, hostname=args.hostname, limits=args.limits,
                 overlay=args.overlay, state_dir=args.state_dir, name=args.name, stats_file=args.stats_file,
                 env=args.env, workdir=args.workdir, network=args.net)
    return run(cfg)
