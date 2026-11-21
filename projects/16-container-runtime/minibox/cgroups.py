"""cgroup v2 through its filesystem: parsing/formatting limit values, and one cgroup per container.

Layout on the host (all created by minibox and removed again):

    /sys/fs/cgroup/minibox/            parent; its cgroup.subtree_control enables cpu, memory, pids
    /sys/fs/cgroup/minibox/<name>/     one leaf per container; limits are written here and the
                                       container's init is moved into its cgroup.procs

A leaf is needed because cgroup v2 only lets a cgroup that has no processes of its own hand
controllers down to children ("no internal processes" rule), so limits live in leaves.
"""
from __future__ import annotations

import errno
import os
import re
import time
from dataclasses import dataclass

CGROUP_ROOT = "/sys/fs/cgroup"
PARENT = "minibox"
CPU_PERIOD_US = 100_000          # the kernel default period for cpu.max
CPU_QUOTA_MIN_US = 1_000         # the kernel rejects a quota below 1 ms
CONTROLLERS = ("cpu", "memory", "pids")

_SIZE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kKmMgGtT]?)(?:i?[bB])?\s*$")
_UNITS = {"": 1, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}


def parse_size(text: str) -> int:
    """'64M' -> 67108864. Units are binary (K = 1024), like docker's --memory. Bytes if no unit."""
    m = _SIZE_RE.match(text)
    if not m:
        raise ValueError(f"bad size {text!r} (examples: 64M, 512k, 1G, 1048576)")
    value = float(m.group(1)) * _UNITS[m.group(2).lower()]
    if value != int(value):
        raise ValueError(f"size {text!r} is not a whole number of bytes")
    if value <= 0:
        raise ValueError(f"size {text!r} must be > 0")
    return int(value)


def format_cpu_max(cpus: float | None, period_us: int = CPU_PERIOD_US) -> str:
    """0.5 -> '50000 100000' (quota then period, microseconds). None -> 'max 100000' (no limit)."""
    if cpus is None:
        return f"max {period_us}"
    if cpus <= 0:
        raise ValueError("cpus must be > 0")
    quota = round(cpus * period_us)
    if quota < CPU_QUOTA_MIN_US:
        raise ValueError(f"cpus={cpus} gives a quota of {quota} us; the kernel minimum is {CPU_QUOTA_MIN_US} us")
    return f"{quota} {period_us}"


def parse_cpu_max(text: str) -> tuple[int | None, int]:
    """'50000 100000' -> (50000, 100000); 'max 100000' -> (None, 100000)."""
    parts = text.split()
    if len(parts) != 2:
        raise ValueError(f"bad cpu.max {text!r}")
    quota = None if parts[0] == "max" else int(parts[0])
    return quota, int(parts[1])


def parse_limit(text: str) -> int | None:
    """memory.max / pids.max / memory.swap.max: 'max' -> None, else an int."""
    t = text.strip()
    return None if t == "max" else int(t)


def parse_flat_keyed(text: str) -> dict[str, int]:
    """'oom 0\\noom_kill 1\\n' -> {'oom': 0, 'oom_kill': 1} (memory.events, pids.events, cpu.stat)."""
    out: dict[str, int] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        key, _, value = line.partition(" ")
        if not value:
            raise ValueError(f"bad flat-keyed line {line!r}")
        out[key] = int(value)
    return out


@dataclass(frozen=True)
class Limits:
    memory: int | None = None    # bytes -> memory.max (and memory.swap.max = 0, see writes())
    pids: int | None = None      # -> pids.max
    cpus: float | None = None    # -> cpu.max

    def writes(self) -> list[tuple[str, str]]:
        """The exact (file, value) pairs written into the leaf, in order. Pure, so it is unit tested."""
        w: list[tuple[str, str]] = []
        if self.memory is not None:
            w.append(("memory.max", str(self.memory)))
            # Without this the kernel swaps the container out instead of OOM-killing it at the limit
            # (portfolio-a2 has a 4 GB swap file), so "--memory 64M" would not mean 64M of RAM+swap.
            w.append(("memory.swap.max", "0"))
        if self.pids is not None:
            if self.pids < 1:
                raise ValueError("pids must be >= 1")
            w.append(("pids.max", str(self.pids)))
        if self.cpus is not None:
            w.append(("cpu.max", format_cpu_max(self.cpus)))
        return w


def _read(path: str) -> str:
    with open(path) as f:
        return f.read()


def _write(path: str, value: str) -> None:
    with open(path, "w") as f:
        f.write(value)


class Cgroup:
    def __init__(self, name: str, root: str = CGROUP_ROOT, parent: str = PARENT):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name) or name in (".", ".."):
            raise ValueError(f"bad cgroup name {name!r}")
        self.name = name
        self.root = root
        self.parent_path = os.path.join(root, parent)
        self.path = os.path.join(self.parent_path, name)

    def file(self, name: str) -> str:
        return os.path.join(self.path, name)

    def read(self, name: str) -> str:
        return _read(self.file(name))

    def create(self, limits: Limits) -> None:
        available = set(_read(os.path.join(self.root, "cgroup.subtree_control")).split())
        missing = [c for c in CONTROLLERS if c not in available]
        if missing:
            # Enabling them at the root would change the whole host; refuse instead.
            raise RuntimeError(f"controllers {missing} are not enabled in {self.root}/cgroup.subtree_control")
        os.makedirs(self.parent_path, exist_ok=True)
        _write(os.path.join(self.parent_path, "cgroup.subtree_control"), " ".join("+" + c for c in CONTROLLERS))
        os.mkdir(self.path)          # fails if it exists: two containers must never share a cgroup
        try:
            for fname, value in limits.writes():
                _write(self.file(fname), value)
        except BaseException:
            self.remove()
            raise

    def add_pid(self, pid: int) -> None:
        _write(self.file("cgroup.procs"), str(pid))

    def pids(self) -> list[int]:
        return [int(p) for p in self.read("cgroup.procs").split()]

    def populated(self) -> bool:
        return parse_flat_keyed(self.read("cgroup.events")).get("populated", 0) == 1

    def kill(self, timeout: float = 5.0) -> None:
        """SIGKILL everything left in the cgroup (cgroup.kill, kernel 5.14+) and wait until it is empty."""
        if not os.path.isdir(self.path):
            return
        if self.populated():
            _write(self.file("cgroup.kill"), "1")
        deadline = time.monotonic() + timeout
        while self.populated():
            if time.monotonic() > deadline:
                raise RuntimeError(f"cgroup {self.path} still populated after kill")
            time.sleep(0.01)

    def stats(self) -> dict:
        """Limits read BACK from the kernel plus the counters the limit tests need."""
        out: dict = {"cgroup": self.path, "limits": {}, "counters": {}}
        for fname in ("memory.max", "memory.swap.max", "pids.max", "cpu.max"):
            try:
                out["limits"][fname] = self.read(fname).strip()
            except FileNotFoundError:
                pass
        for fname in ("memory.events", "pids.events", "cpu.stat"):
            try:
                out["counters"][fname] = parse_flat_keyed(self.read(fname))
            except FileNotFoundError:
                pass
        for fname in ("memory.peak", "pids.peak"):
            try:
                out["counters"][fname] = int(self.read(fname))
            except (FileNotFoundError, ValueError):
                pass
        return out

    def remove(self) -> None:
        """rmdir the leaf, then the parent if no other container uses it. A cgroup dir is removed
        with rmdir even though it 'contains' files: they are kernel interface files, not real ones."""
        try:
            os.rmdir(self.path)
        except FileNotFoundError:
            pass
        try:
            os.rmdir(self.parent_path)
        except OSError as e:
            if e.errno not in (errno.EBUSY, errno.ENOTEMPTY, errno.ENOENT):
                raise
