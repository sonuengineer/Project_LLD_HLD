"""Integration tests: real namespaces, mounts and cgroups. They need Linux, root and an image rootfs:

    sudo MINIBOX_TEST_ROOTFS=$HOME/h16/images/alpine/rootfs python3 -m pytest tests/integration

Everything else (Windows, macOS, non-root, no rootfs) skips them with the reason.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT = Path(__file__).resolve().parents[2]
ROOTFS = os.environ.get("MINIBOX_TEST_ROOTFS", "")


def pytest_collection_modifyitems(config, items):
    reason = None
    if sys.platform != "linux":
        reason = "integration tests need Linux"
    elif os.geteuid() != 0:
        reason = "integration tests need root (sudo)"
    elif not ROOTFS or not os.path.isfile(os.path.join(ROOTFS, "bin", "busybox")):
        reason = "set MINIBOX_TEST_ROOTFS to an alpine/busybox rootfs (python -m minibox pull alpine:3.20 --dest D)"
    for item in items:
        if "integration" in str(item.fspath):
            item.add_marker(pytest.mark.integration)
            if reason:
                item.add_marker(pytest.mark.skip(reason=reason))


@pytest.fixture
def rootfs() -> str:
    return ROOTFS


@pytest.fixture
def state_dir(tmp_path) -> str:
    d = tmp_path / "state"
    d.mkdir()
    return str(d)


@pytest.fixture(autouse=True)
def no_leftovers():
    """Every test must leave no cgroup of ours and no mount of ours behind."""
    yield
    if sys.platform == "linux" and os.path.isdir("/sys/fs/cgroup/minibox"):
        left = [d for d in os.listdir("/sys/fs/cgroup/minibox") if os.path.isdir(f"/sys/fs/cgroup/minibox/{d}")]
        assert not left, f"cgroups left behind: {left}"
    if sys.platform == "linux":
        with open("/proc/self/mounts") as f:
            ours = [line for line in f if "/state/" in line or "minibox" in line]
        assert not ours, f"mounts left in the host namespace: {ours}"


class Box:
    def __init__(self, rootfs: str, state_dir: str, tmp_path: Path):
        self.rootfs, self.state_dir, self.tmp = rootfs, state_dir, tmp_path

    def argv(self, cmd: list[str] | str, *opts: str) -> list[str]:
        if isinstance(cmd, str):
            cmd = ["/bin/sh", "-c", cmd]
        return [sys.executable, "-m", "minibox", "run", "--rootfs", self.rootfs, "--state-dir", self.state_dir,
                *opts, "--", *cmd]

    def run(self, cmd, *opts, timeout: float = 30, input: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(self.argv(cmd, *opts), cwd=PROJECT, capture_output=True, text=True,
                              timeout=timeout, input=input)

    def popen(self, cmd, *opts, **kw) -> subprocess.Popen:
        kw.setdefault("stdout", subprocess.PIPE)
        kw.setdefault("stderr", subprocess.PIPE)
        return subprocess.Popen(self.argv(cmd, *opts), cwd=PROJECT, text=True, **kw)


@pytest.fixture
def box(rootfs, state_dir, tmp_path) -> Box:
    return Box(rootfs, state_dir, tmp_path)
