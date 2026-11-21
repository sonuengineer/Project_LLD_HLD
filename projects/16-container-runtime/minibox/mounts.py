"""The container's filesystem: a mount PLAN built as plain data, then applied.

Building the plan is pure (unit tested anywhere); applying it needs Linux, root and a private
mount namespace (integration tested). Order matters and is part of what the tests check:

    1. make every mount in the new namespace private, so nothing we mount leaks to the host
    2. the root: an overlay (image read-only + per-container upper dir) or a bind of the rootfs
       onto itself (pivot_root needs new_root to be a mount point)
    3. a fresh /proc (only now does it show the new PID namespace)
    4. a tmpfs /dev with a few device nodes and the usual symlinks, a private devpts, /dev/shm
    5. pivot_root into the new root, then detach the old root so the host tree is gone
"""
from __future__ import annotations

import os
import stat
from dataclasses import dataclass, field

from . import libc

OLD_ROOT = ".oldroot"

# (name, major, minor): the same small set runc creates
DEVICES = [("null", 1, 3), ("zero", 1, 5), ("full", 1, 7), ("random", 1, 8), ("urandom", 1, 9), ("tty", 5, 0)]
DEV_SYMLINKS = [("fd", "/proc/self/fd"), ("stdin", "/proc/self/fd/0"), ("stdout", "/proc/self/fd/1"),
                ("stderr", "/proc/self/fd/2"), ("ptmx", "pts/ptmx")]


@dataclass(frozen=True)
class Mount:
    source: str | None
    target: str
    fstype: str | None
    flags: int = 0
    data: str | None = None


@dataclass(frozen=True)
class Mkdir:
    path: str
    mode: int = 0o755


@dataclass(frozen=True)
class Mknod:
    path: str
    major: int
    minor: int
    mode: int = 0o666


@dataclass(frozen=True)
class Symlink:
    path: str
    target: str


Step = Mount | Mkdir | Mknod | Symlink


@dataclass(frozen=True)
class OverlayDirs:
    lower: str     # the image rootfs, never written
    upper: str     # this container's changes
    work: str      # overlayfs scratch dir, same filesystem as upper
    merged: str    # where the combined view is mounted; becomes the container's /


def overlay_options(o: OverlayDirs) -> str:
    for p in (o.lower, o.upper, o.work):
        # ',' separates options and ':' separates lower layers; overlayfs has escaping rules for
        # them, but refusing such paths is simpler and safer than getting the escaping wrong.
        if "," in p or ":" in p:
            raise ValueError(f"overlay path may not contain ',' or ':': {p!r}")
    return f"lowerdir={o.lower},upperdir={o.upper},workdir={o.work}"


@dataclass
class Plan:
    new_root: str
    steps: list[Step] = field(default_factory=list)


def build_plan(rootfs: str, overlay: OverlayDirs | None = None, mount_proc: bool = True) -> Plan:
    if overlay is not None and os.path.abspath(overlay.lower) != os.path.abspath(rootfs):
        raise ValueError("overlay.lower must be the rootfs")
    new_root = overlay.merged if overlay else rootfs
    j = lambda *p: os.path.join(new_root, *p)  # noqa: E731
    steps: list[Step] = [Mount(None, "/", None, libc.MS_REC | libc.MS_PRIVATE)]
    if overlay:
        steps.append(Mount("overlay", overlay.merged, "overlay", 0, overlay_options(overlay)))
    else:
        steps.append(Mount(rootfs, rootfs, None, libc.MS_BIND | libc.MS_REC))
    if mount_proc:
        steps += [Mkdir(j("proc")),
                  Mount("proc", j("proc"), "proc", libc.MS_NOSUID | libc.MS_NOEXEC | libc.MS_NODEV)]
    steps += [Mkdir(j("dev")),
              Mount("tmpfs", j("dev"), "tmpfs", libc.MS_NOSUID | libc.MS_STRICTATIME, "mode=755,size=65536k")]
    steps += [Mknod(j("dev", name), major, minor) for name, major, minor in DEVICES]
    steps += [Symlink(j("dev", name), target) for name, target in DEV_SYMLINKS]
    steps += [Mkdir(j("dev", "pts")),
              Mount("devpts", j("dev", "pts"), "devpts", libc.MS_NOSUID | libc.MS_NOEXEC,
                    "newinstance,ptmxmode=0666,mode=620")]
    steps += [Mkdir(j("dev", "shm"), 0o1777),
              Mount("shm", j("dev", "shm"), "tmpfs", libc.MS_NOSUID | libc.MS_NODEV | libc.MS_NOEXEC,
                    "mode=1777,size=65536k")]
    steps.append(Mkdir(j(OLD_ROOT), 0o700))
    return Plan(new_root=new_root, steps=steps)


def apply_step(s: Step) -> None:
    if isinstance(s, Mount):
        libc.mount(s.source, s.target, s.fstype, s.flags, s.data)
    elif isinstance(s, Mkdir):
        os.makedirs(s.path, exist_ok=True)
        os.chmod(s.path, s.mode)       # makedirs' mode is filtered by the umask; set it exactly
    elif isinstance(s, Mknod):
        if os.path.lexists(s.path):
            os.unlink(s.path)
        os.mknod(s.path, s.mode | stat.S_IFCHR, os.makedev(s.major, s.minor))
        os.chmod(s.path, s.mode)
    elif isinstance(s, Symlink):
        if os.path.lexists(s.path):
            os.unlink(s.path)
        os.symlink(s.target, s.path)
    else:  # pragma: no cover
        raise TypeError(s)


def apply_plan(plan: Plan) -> None:
    for s in plan.steps:
        apply_step(s)


def enter_root(new_root: str, use_pivot_root: bool = True) -> None:
    """Make new_root the process's /.

    pivot_root moves the old root to new_root/.oldroot; we then detach it, so the host's tree is no
    longer mounted anywhere in this namespace. chroot only changes this process's idea of '/': the
    host tree stays mounted, and a root process can walk back out (README, "chroot escape").
    use_pivot_root=False exists ONLY so a test can prove that difference.
    """
    if use_pivot_root:
        put_old = os.path.join(new_root, OLD_ROOT)
        libc.pivot_root(new_root, put_old)
        os.chdir("/")
        libc.umount2("/" + OLD_ROOT, libc.MNT_DETACH)
        os.rmdir("/" + OLD_ROOT)
    else:
        os.chdir(new_root)
        os.chroot(".")
        os.chdir("/")
