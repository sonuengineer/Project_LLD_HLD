"""Stage 2: cgroup v2 limits, each proven by a process that runs into it.

The numbers are read from the --stats-file minibox writes just before it removes the cgroup.
"""
from __future__ import annotations

import json
import os
import subprocess
import time


def stats(path) -> dict:
    with open(path) as f:
        return json.load(f)


def test_limits_are_written_and_read_back(box, tmp_path):
    sf = tmp_path / "s.json"
    r = box.run("true", "--memory", "64M", "--pids", "32", "--cpus", "0.5", "--stats-file", str(sf))
    assert r.returncode == 0, r.stderr
    lim = stats(sf)["limits"]
    assert lim == {"memory.max": "67108864", "memory.swap.max": "0", "pids.max": "32", "cpu.max": "50000 100000"}


def test_no_flags_means_no_limits(box, tmp_path):
    sf = tmp_path / "s.json"
    box.run("true", "--stats-file", str(sf))
    assert stats(sf)["limits"] == {"memory.max": "max", "memory.swap.max": "max", "pids.max": "max",
                                   "cpu.max": "max 100000"}


def test_container_runs_in_its_own_cgroup(box):
    # no cgroup namespace (see README), so the full host path is visible. Repeated, because the bug
    # this guards against (the command forked before INIT joined the cgroup) is a race.
    for i in range(10):
        r = box.run("cat /proc/self/cgroup", "--name", f"cg-path-{i}")
        assert r.stdout.strip() == f"0::/minibox/cg-path-{i}", f"run {i}: {r.stdout!r}"


def test_spawning_past_pids_max_fails(box, tmp_path):
    # bounded on purpose (100 sleepers), so it is also safe to run when the limit is NOT written
    sf = tmp_path / "s.json"
    r = box.run("i=0; while [ $i -lt 100 ]; do sleep 5 & i=$((i+1)); done; echo all-started",
                "--pids", "32", "--stats-file", str(sf))
    s = stats(sf)["counters"]
    assert "all-started" not in r.stdout
    assert "can't fork" in r.stderr
    assert s["pids.peak"] == 32 and s["pids.events"]["max"] >= 1


def test_fork_bomb_is_stopped_by_pids_max(box, tmp_path):
    # a real, unbounded fork bomb: every copy starts a background copy and recurses. Without
    # pids.max it would take the whole server down, so it is never run with the limit removed.
    sf = tmp_path / "s.json"
    t = time.monotonic()
    r = box.run("bomb() { bomb & bomb; }; bomb", "--pids", "32", "--stats-file", str(sf), timeout=30)
    s = stats(sf)["counters"]
    assert r.returncode != 0 and "can't fork" in r.stderr     # busybox sh gives up when fork fails
    assert s["pids.peak"] == 32                               # it reached the limit and no further
    assert s["pids.events"]["max"] >= 1                       # forks refused by the kernel
    assert time.monotonic() - t < 30
    assert subprocess.run(["/bin/true"]).returncode == 0      # the host can still start processes


def test_memory_hog_is_oom_killed(box, tmp_path):
    sf = tmp_path / "s.json"
    # doubles a shell string up to 2^27 bytes (128 MiB, a few hundred MiB of shell memory): far over
    # the limit, but bounded, so it is also safe to run when the limit is NOT written
    r = box.run('x=a; i=0; while [ $i -lt 27 ]; do x="$x$x"; i=$((i+1)); done; echo survived',
                "--memory", "64M", "--stats-file", str(sf), timeout=60)
    s = stats(sf)["counters"]
    assert r.returncode == 137 and "survived" not in r.stdout   # SIGKILL from the OOM killer -> 128 + 9
    assert s["memory.events"]["oom_kill"] >= 1
    assert s["memory.peak"] <= 64 << 20


def test_memory_below_the_limit_is_fine(box, tmp_path):
    sf = tmp_path / "s.json"
    # 2^24 = 16 MiB string, under a 128M limit
    r = box.run('x=a; i=0; while [ $i -lt 24 ]; do x="$x$x"; i=$((i+1)); done; echo ${#x}',
                "--memory", "128M", "--stats-file", str(sf), timeout=60)
    assert r.returncode == 0 and r.stdout.strip() == str(1 << 24)
    assert stats(sf)["counters"]["memory.events"]["oom_kill"] == 0


def run_cpu_hog(box, tmp_path, seconds: float, *opts) -> dict:
    sf = tmp_path / "cpu.json"
    r = box.run(f"timeout {seconds} sh -c 'while :; do :; done'; true", *opts, "--stats-file", str(sf), timeout=60)
    assert r.returncode == 0, r.stderr
    return stats(sf)


def test_cpu_hog_is_throttled_by_cpu_max(box, tmp_path):
    s = run_cpu_hog(box, tmp_path, 3, "--cpus", "0.5")
    cpu = s["counters"]["cpu.stat"]
    share = cpu["usage_usec"] / (s["wall_s"] * 1e6)
    assert cpu["nr_throttled"] > 0 and cpu["throttled_usec"] > 0
    assert 0.35 < share < 0.6, share             # 0.5 CPU, plus startup outside the hog


def test_cpu_hog_without_limit_is_not_throttled(box, tmp_path):
    s = run_cpu_hog(box, tmp_path, 2)
    cpu = s["counters"]["cpu.stat"]
    assert cpu["nr_throttled"] == 0 and cpu["throttled_usec"] == 0
    assert cpu["usage_usec"] / (s["wall_s"] * 1e6) > 0.8


def test_two_containers_get_separate_cgroups(box, tmp_path):
    a = box.popen(["/bin/sh", "-c", "echo ready; read x"], "--name", "two-a", "--pids", "10", stdin=subprocess.PIPE)
    b = box.popen(["/bin/sh", "-c", "echo ready; read x"], "--name", "two-b", "--pids", "20", stdin=subprocess.PIPE)
    try:
        assert a.stdout.readline().strip() == "ready" and b.stdout.readline().strip() == "ready"
        assert open("/sys/fs/cgroup/minibox/two-a/pids.max").read().strip() == "10"
        assert open("/sys/fs/cgroup/minibox/two-b/pids.max").read().strip() == "20"
        a.communicate("\n", timeout=10)
        # the parent cgroup stays while the other container still uses it
        assert os.path.isdir("/sys/fs/cgroup/minibox/two-b") and not os.path.exists("/sys/fs/cgroup/minibox/two-a")
    finally:
        for p in (a, b):
            if p.poll() is None:
                p.communicate("\n", timeout=10)
    assert a.returncode == 0 and b.returncode == 0
