"""Measure the three cgroup limits (and container start time) and write raw JSON + generated tables.

    sudo python3 bench/limits.py --rootfs DIR --state-dir DIR --out bench/reference-results/<label> [--runs 3]
    python3 bench/limits.py --render bench/reference-results/<label> [--update-readme README.md]

Every number in the tables comes from a --stats-file that minibox wrote (cgroup counters read just
before the cgroup was removed) or from this script's own clock. Nothing is typed by hand.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
START, END = "<!-- MEASURED:START -->", "<!-- MEASURED:END -->"


def run_box(rootfs: str, state: str, cmd: str, *opts: str, timeout: float = 120) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
        sf = tf.name
    argv = [sys.executable, "-m", "minibox", "run", "--rootfs", rootfs, "--state-dir", state, "--stats-file", sf,
            *opts, "--", "/bin/sh", "-c", cmd]
    t0 = time.monotonic()
    p = subprocess.run(argv, cwd=PROJECT, capture_output=True, text=True, timeout=timeout)
    wall = time.monotonic() - t0
    with open(sf) as f:
        stats = json.load(f)
    os.unlink(sf)
    return {"cmd": cmd, "opts": list(opts), "exit": p.returncode, "outer_wall_s": round(wall, 4),
            "stderr_lines": len(p.stderr.splitlines()), "stderr_head": p.stderr.splitlines()[:3],
            "stdout_tail": p.stdout.splitlines()[-3:], "stats": stats}


def conditions() -> dict:
    def sh(c):
        return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
    return {"date_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()), "kernel": platform.release(),
            "machine": platform.machine(), "cpus": os.cpu_count(), "python": platform.python_version(),
            "cpu_model": sh("lscpu | sed -n 's/^Model name: *//p' | head -1"),
            "loadavg_before": open("/proc/loadavg").read().split()[:3],
            "mem_available_mib": int(sh("awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo") or 0),
            "commit": os.environ.get("BENCH_COMMIT", "unknown")}


HOG_MEM = 'x=a; i=0; while [ $i -lt 27 ]; do x="$x$x"; i=$((i+1)); done; echo survived'
HOG_MEM_SMALL = 'x=a; i=0; while [ $i -lt 24 ]; do x="$x$x"; i=$((i+1)); done; echo survived'
SPAWN = "i=0; while [ $i -lt 100 ]; do sleep 5 & i=$((i+1)); done; echo all-started"
BOMB = "bomb() { bomb & bomb; }; bomb"


def cpu_hog(seconds: int) -> str:
    return f"timeout {seconds} sh -c 'while :; do :; done'; true"


def measure(rootfs: str, state: str, out: Path, runs: int, cpu_seconds: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "conditions.json").write_text(json.dumps(conditions(), indent=1))

    start = [run_box(rootfs, state, "true") for _ in range(max(20, runs))]
    (out / "l0-start.json").write_text(json.dumps(start, indent=1))

    pids = []
    for _ in range(runs):
        pids.append({"case": "100 sleepers, pids.max=32", **run_box(rootfs, state, SPAWN, "--pids", "32")})
        pids.append({"case": "fork bomb, pids.max=32", **run_box(rootfs, state, BOMB, "--pids", "32")})
    (out / "l1-pids.json").write_text(json.dumps(pids, indent=1))

    mem = []
    for _ in range(runs):
        mem.append({"case": "hog to 128 MiB string, memory.max=64M", **run_box(rootfs, state, HOG_MEM, "--memory", "64M")})
        mem.append({"case": "16 MiB string, memory.max=64M", **run_box(rootfs, state, HOG_MEM_SMALL, "--memory", "64M")})
    (out / "l2-memory.json").write_text(json.dumps(mem, indent=1))

    cpu = []
    for _ in range(runs):
        for cpus in (None, "1.0", "0.5", "0.25"):
            opts = ("--cpus", cpus) if cpus else ()
            cpu.append({"cpus": cpus or "no limit", **run_box(rootfs, state, cpu_hog(cpu_seconds), *opts)})
    (out / "l3-cpu.json").write_text(json.dumps(cpu, indent=1))
    render(out)


def med(values, fmt="{:.0f}") -> str:
    values = list(values)
    m = statistics.median(values)
    if len(values) == 1:
        return fmt.format(m)
    return f"{fmt.format(m)} ({fmt.format(min(values))}-{fmt.format(max(values))})"


def render(out: Path) -> str:
    c = json.loads((out / "conditions.json").read_text())
    lines = [f"### Run `{out.name}`", "",
             f"{c['date_utc']} UTC, {c['machine']}, {c['cpus']} CPUs ({c['cpu_model']}), kernel {c['kernel']}, "
             f"Python {c['python']}, commit `{c['commit']}`, load average before {' '.join(c['loadavg_before'])}, "
             f"{c['mem_available_mib']} MiB available. Raw data: `bench/reference-results/{out.name}/`. "
             "Median, min-max in brackets.", ""]

    start = json.loads((out / "l0-start.json").read_text())
    lines += ["#### L0 Start + stop of an empty container (`true`)", "",
              "Outer = measured by this script around the whole `python3 -m minibox run` process (Python start-up "
              "included); inner = minibox's own clock from before the cgroup is created to after the command "
              "exited.", "",
              "| runs | outer ms | inner ms |", "|---|---|---|",
              f"| {len(start)} | {med([r['outer_wall_s'] * 1000 for r in start])} | "
              f"{med([r['stats']['wall_s'] * 1000 for r in start])} |", "", "Raw: `l0-start.json`", ""]

    pids = json.loads((out / "l1-pids.json").read_text())
    lines += ["#### L1 pids.max = 32", "",
              "`pids.peak` = most processes the cgroup ever had; `pids.events max` = forks the kernel refused. "
              "busybox sh exits when a fork fails, which is what ends the fork bomb.", "",
              "| case | runs | exit code | pids.peak | pids.events max | `can't fork` messages | wall ms |",
              "|---|---|---|---|---|---|---|"]
    for case in dict.fromkeys(r["case"] for r in pids):
        rs = [r for r in pids if r["case"] == case]
        lines.append(f"| {case} | {len(rs)} | {med([r['exit'] for r in rs])} | "
                     f"{med([r['stats']['counters']['pids.peak'] for r in rs])} | "
                     f"{med([r['stats']['counters']['pids.events']['max'] for r in rs])} | "
                     f"{med([r['stderr_lines'] for r in rs])} | {med([r['stats']['wall_s'] * 1000 for r in rs])} |")
    lines += ["", "Raw: `l1-pids.json`", ""]

    mem = json.loads((out / "l2-memory.json").read_text())
    lines += ["#### L2 memory.max = 64M (memory.swap.max = 0)", "",
              "`oom_kill` from memory.events; peak from memory.peak. Exit 137 = killed by SIGKILL (128 + 9).", "",
              "| case | runs | exit code | printed `survived` | oom_kill | memory.events max | memory.peak MiB | wall ms |",
              "|---|---|---|---|---|---|---|---|"]
    for case in dict.fromkeys(r["case"] for r in mem):
        rs = [r for r in mem if r["case"] == case]
        ev = [r["stats"]["counters"]["memory.events"] for r in rs]
        lines.append(f"| {case} | {len(rs)} | {med([r['exit'] for r in rs])} | "
                     f"{sum('survived' in r['stdout_tail'] for r in rs)} of {len(rs)} | "
                     f"{med([e['oom_kill'] for e in ev])} | {med([e['max'] for e in ev])} | "
                     f"{med([r['stats']['counters']['memory.peak'] / 1048576 for r in rs], '{:.1f}')} | "
                     f"{med([r['stats']['wall_s'] * 1000 for r in rs])} |")
    lines += ["", "Raw: `l2-memory.json`", ""]

    cpu = json.loads((out / "l3-cpu.json").read_text())
    lines += ["#### L3 cpu.max: one busy loop (`timeout N sh -c 'while :; do :; done'`)", "",
              "CPU share = cpu.stat usage_usec / minibox's wall time (container start-up included, so slightly "
              "below the quota). One busy loop can use at most 1 CPU, so `1.0` and no limit should match.", "",
              "| cpus | cpu.max | runs | CPU share | nr_periods | nr_throttled | throttled ms | wall s |",
              "|---|---|---|---|---|---|---|---|"]
    for cpus in dict.fromkeys(r["cpus"] for r in cpu):
        rs = [r for r in cpu if r["cpus"] == cpus]
        st = [r["stats"]["counters"]["cpu.stat"] for r in rs]
        lines.append(f"| {cpus} | `{rs[0]['stats']['limits']['cpu.max']}` | {len(rs)} | "
                     f"{med([s['usage_usec'] / (r['stats']['wall_s'] * 1e6) for s, r in zip(st, rs)], '{:.3f}')} | "
                     f"{med([s['nr_periods'] for s in st])} | {med([s['nr_throttled'] for s in st])} | "
                     f"{med([s['throttled_usec'] / 1000 for s in st])} | "
                     f"{med([r['stats']['wall_s'] for r in rs], '{:.2f}')} |")
    lines += ["", "Raw: `l3-cpu.json`", ""]
    text = "\n".join(lines)
    (out / "SUMMARY.md").write_text(text + "\n")
    return text


def update_readme(readme: Path, sections: list[str]) -> None:
    body = readme.read_text()
    a, b = body.index(START), body.index(END)
    gen = "\n".join([START, "<!-- generated by bench/limits.py --render from bench/reference-results; do not edit -->",
                     "", *sections, END])
    readme.write_text(body[:a] + gen + body[b + len(END):])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rootfs")
    ap.add_argument("--state-dir")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--cpu-seconds", type=int, default=5)
    ap.add_argument("--render", type=Path, nargs="*")
    ap.add_argument("--update-readme", type=Path)
    a = ap.parse_args()
    if a.render:
        sections = [render(p) for p in a.render]
        if a.update_readme:
            update_readme(a.update_readme, sections)
        else:
            print("\n".join(sections))
        return 0
    if not (a.rootfs and a.state_dir and a.out):
        ap.error("--rootfs, --state-dir and --out are needed to measure")
    measure(a.rootfs, a.state_dir, a.out, a.runs, a.cpu_seconds)
    print((a.out / "SUMMARY.md").read_text())
    return 0


if __name__ == "__main__":
    sys.exit(main())
