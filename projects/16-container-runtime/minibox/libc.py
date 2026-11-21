"""Thin ctypes wrappers for the few syscalls the Python stdlib does not expose.

os.unshare, os.setns, os.chroot, os.fork, os.execvp, os.mknod and socket.sethostname exist in the
stdlib (3.12). mount(2), umount2(2) and pivot_root(2) do not, so they go through libc.

libc is loaded lazily, so importing this module works on Windows / macOS (the unit tests import it).
"""
from __future__ import annotations

import ctypes
import ctypes.util
import os
import platform

# mount(2) flags, from <sys/mount.h> (same values on x86_64 and arm64)
MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_NOEXEC = 8
MS_REMOUNT = 32
MS_BIND = 4096
MS_REC = 16384
MS_PRIVATE = 1 << 18
MS_STRICTATIME = 1 << 24

# umount2(2) flags
MNT_DETACH = 2

# pivot_root has no glibc wrapper; it is called by syscall number.
SYS_PIVOT_ROOT = {"x86_64": 155, "aarch64": 41, "arm64": 41}

_libc = None


def libc() -> ctypes.CDLL:
    global _libc
    if _libc is None:
        # Try the glibc soname first: ctypes.util.find_library runs a subprocess (ldconfig), and
        # inside the container that extra fork would take PID 2 before the user's command does.
        try:
            _libc = ctypes.CDLL("libc.so.6", use_errno=True)
        except OSError:
            _libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    return _libc


def _check(ret: int, what: str) -> None:
    if ret != 0:
        err = ctypes.get_errno()
        raise OSError(err, f"{what}: {os.strerror(err)}")


def _b(s: str | None) -> bytes | None:
    return None if s is None else os.fsencode(s)


def mount(source: str | None, target: str, fstype: str | None, flags: int = 0, data: str | None = None) -> None:
    c = libc()
    c.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    _check(c.mount(_b(source), _b(target), _b(fstype), flags, _b(data)), f"mount({source!r}, {target!r}, {fstype!r})")


def umount2(target: str, flags: int = 0) -> None:
    c = libc()
    c.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
    _check(c.umount2(_b(target), flags), f"umount2({target!r})")


def pivot_root(new_root: str, put_old: str) -> None:
    nr = SYS_PIVOT_ROOT.get(platform.machine())
    if nr is None:
        raise OSError(f"pivot_root: unknown syscall number for {platform.machine()}")
    c = libc()
    c.syscall.restype = ctypes.c_long
    _check(c.syscall(ctypes.c_long(nr), _b(new_root), _b(put_old)), f"pivot_root({new_root!r}, {put_old!r})")

