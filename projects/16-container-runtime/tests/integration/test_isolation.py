"""Stage 1: namespaces, pivot_root, /proc, /dev, PID 1 duties, exit codes."""
from __future__ import annotations

import os
import signal
import socket
import time

import pytest

from minibox import mounts
from minibox.container import Config, setup_container


def test_hostname_is_private(box):
    before = socket.gethostname()
    r = box.run("hostname", "--hostname", "box1")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "box1"
    assert socket.gethostname() == before


@pytest.mark.parametrize("ns", ["pid", "uts", "ipc", "mnt", "net"])
def test_every_namespace_differs_from_the_host(box, ns):
    r = box.run(f"readlink /proc/self/ns/{ns}")
    assert r.returncode == 0, r.stderr
    inside = r.stdout.strip()
    assert inside.startswith(f"{ns}:[") and inside != os.readlink(f"/proc/self/ns/{ns}")


def test_user_namespace_is_shared_with_the_host(box):
    # stated limitation, checked so the README stays true: root in the box IS root on the host
    r = box.run("readlink /proc/self/ns/user; id -u")
    assert r.stdout.split() == [os.readlink("/proc/self/ns/user"), "0"]


def test_command_is_pid_2_and_init_is_pid_1(box):
    r = box.run("echo $$; tr '\\0' ' ' < /proc/1/cmdline")
    assert r.returncode == 0, r.stderr
    pid, cmdline = r.stdout.splitlines()
    assert pid == "2"
    assert "minibox" in cmdline


def test_proc_is_fresh_and_shows_only_the_container(box):
    r = box.run("ls /proc | grep -E '^[0-9]+$' | sort -n | tr '\\n' ' '")
    pids = [int(p) for p in r.stdout.split()]
    # init, sh, and the pipeline's own processes; never the host's hundreds of PIDs
    assert pids[:2] == [1, 2] and len(pids) <= 6, pids


def test_only_the_containers_own_mounts_are_visible(box):
    r = box.run("cut -d' ' -f2 /proc/mounts")
    assert r.returncode == 0, r.stderr
    assert sorted(r.stdout.split()) == ["/", "/dev", "/dev/pts", "/dev/shm", "/proc"]


def test_root_is_the_overlay(box):
    r = box.run("grep ' / ' /proc/mounts")
    assert r.stdout.startswith("overlay / overlay ") and f"lowerdir={box.rootfs}" in r.stdout


def test_minimal_dev(box):
    r = box.run("ls /dev | tr '\\n' ' '; echo; echo x > /dev/null && head -c 16 /dev/urandom | wc -c; "
                "head -c 4 /dev/zero | od -An -tx1")
    lines = r.stdout.splitlines()
    assert set(lines[0].split()) == {"fd", "full", "null", "ptmx", "pts", "random", "shm", "stderr", "stdin",
                                     "stdout", "tty", "urandom", "zero"}
    assert lines[1].strip() == "16"
    assert lines[2].split() == ["00", "00", "00", "00"]


def test_host_block_devices_are_absent(box):
    r = box.run("ls /dev/sda /dev/vda /dev/nvme0n1 /dev/mem 2>&1; true")
    assert "No such file" in r.stdout and "/dev/mem" in r.stdout


def test_only_loopback_network_and_it_is_up(box):
    r = box.run("cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' '; ping -c 1 -W 1 127.0.0.1 >/dev/null && echo PING-OK")
    lines = r.stdout.split()
    assert lines == ["lo", "PING-OK"], r.stdout + r.stderr


def test_ipc_namespace_hides_host_shared_memory(box):
    seg = None
    try:
        import ctypes
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        seg = libc.shmget(0x16161616, 4096, 0o1600)          # IPC_CREAT | 0600
        assert seg >= 0
        key = str(0x16161616)                                 # /proc/sysvipc/shm prints keys in decimal
        assert key in open("/proc/sysvipc/shm").read()
        r = box.run("cat /proc/sysvipc/shm")
        assert r.returncode == 0 and key not in r.stdout
    finally:
        if seg is not None and seg >= 0:
            libc.shmctl(seg, 0, None)                         # IPC_RMID


@pytest.mark.parametrize("cmd,code", [("exit 0", 0), ("exit 7", 7), ("exit 255", 255), ("kill -9 $$", 137),
                                      ("kill -TERM $$", 143)])
def test_exit_code_is_propagated(box, cmd, code):
    assert box.run(cmd).returncode == code


def test_command_not_found_is_127(box):
    r = box.run(["/no/such/binary"])
    assert r.returncode == 127 and "not found" in r.stderr


def test_not_executable_is_126(box):
    r = box.run(["/etc/passwd"])
    assert r.returncode == 126


def test_bad_rootfs_is_125(box, tmp_path):
    box.rootfs = str(tmp_path / "nope")
    assert box.run("true").returncode == 125


def test_stdin_and_stdout_pass_through(box):
    r = box.run(["/bin/cat"], input="hello from the host\n")
    assert r.stdout == "hello from the host\n"


def test_host_environment_does_not_leak(box, monkeypatch):
    monkeypatch.setenv("SECRET_TOKEN", "do-not-leak")
    r = box.run("env", "-e", "FOO=bar", "--hostname", "envbox")
    assert "SECRET_TOKEN" not in r.stdout
    assert "FOO=bar" in r.stdout and "HOSTNAME=envbox" in r.stdout


def test_sigpipe_has_its_default_action_in_the_command(box):
    # Python ignores SIGPIPE; an ignored signal survives exec. 'yes' must die quietly from SIGPIPE
    # when 'head' closes the pipe, not get EPIPE and complain.
    r = box.run("yes | head -n 1; echo done")
    assert r.stdout.split() == ["y", "done"] and r.stderr == "", r.stderr


def test_workdir(box):
    assert box.run(["/bin/pwd"], "-w", "/etc").stdout.strip() == "/etc"


def test_sigterm_is_forwarded_to_the_command(box):
    p = box.popen("trap 'echo got-term; exit 42' TERM; echo ready; while true; do sleep 0.1; done")
    assert p.stdout.readline().strip() == "ready"
    p.send_signal(signal.SIGTERM)
    out, _ = p.communicate(timeout=10)
    assert p.returncode == 42 and "got-term" in out


def test_sigterm_stops_a_command_without_a_handler(box):
    # as PID 2 (not 1) the command gets the normal default action, so 'sleep' dies at once
    p = box.popen(["/bin/sh", "-c", "echo ready; exec sleep 1000"])
    assert p.stdout.readline().strip() == "ready"
    t = time.monotonic()
    p.send_signal(signal.SIGTERM)
    p.communicate(timeout=10)
    assert p.returncode == 143 and time.monotonic() - t < 3


def test_orphans_are_reaped_by_init(box):
    # the inner sh exits at once, its 'sleep 0.2' is re-parented to PID 1 and exits 0.2 s later;
    # 1 s after that it must be gone, not a zombie
    r = box.run("sh -c 'sleep 0.2 &'; sleep 1.2; grep -h '^State' /proc/[0-9]*/status | sort | uniq -c")
    assert r.returncode == 0, r.stderr
    assert "zombie" not in r.stdout, r.stdout


def test_everything_in_the_container_dies_with_the_command(box, tmp_path):
    # PID 1 exits when the command exits; the kernel then kills the rest of the namespace
    t = time.monotonic()
    r = box.run("sleep 100 & sleep 100 & echo started")
    assert r.returncode == 0 and r.stdout.strip() == "started"
    assert time.monotonic() - t < 10


def test_state_dir_and_cgroup_are_removed(box, state_dir):
    r = box.run("true", "--name", "cleanup-check")
    assert r.returncode == 0
    assert os.listdir(state_dir) == []
    assert not os.path.exists("/sys/fs/cgroup/minibox/cleanup-check")


def test_failed_setup_also_cleans_up(box, state_dir):
    r = box.run(["/bin/true"], "--name", "bad-workdir", "-w", "/does/not/exist")
    assert r.returncode == 125 and "workdir" in r.stderr
    assert os.listdir(state_dir) == []
    assert not os.path.exists("/sys/fs/cgroup/minibox/bad-workdir")


def test_two_containers_with_the_same_name_cannot_run_at_once(box):
    p = box.popen(["/bin/sh", "-c", "echo ready; sleep 5"], "--name", "dup")
    assert p.stdout.readline().strip() == "ready"
    r = box.run("echo second", "--name", "dup")
    assert r.returncode == 125 and "second" not in r.stdout
    assert os.path.isdir("/sys/fs/cgroup/minibox/dup"), "the failed second run removed the first one's cgroup"
    p.send_signal(signal.SIGTERM)
    p.communicate(timeout=10)


# ---- pivot_root vs chroot: the escape ------------------------------------------------------------

def _escape_attempt(rootfs: str, tmp_path, use_pivot_root: bool) -> bool:
    """Set up a container root in a forked child, then try the classic chroot escape as root:
    chroot into a subdir WITHOUT chdir'ing into it, walk '..' upwards, chroot('.'). Returns True if
    a marker file that exists only on the host became visible."""
    marker = tmp_path / "HOST-ONLY-MARKER"
    marker.write_text("host")
    st = tmp_path / "esc"
    o = mounts.OverlayDirs(lower=rootfs, upper=str(st / "upper"), work=str(st / "work"), merged=str(st / "merged"))
    for d in (o.upper, o.work, o.merged):
        os.makedirs(d)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        result = b"E"
        try:
            os.close(r)
            setup_container(Config(rootfs=rootfs, command=["x"], use_pivot_root=use_pivot_root),
                            mounts.build_plan(rootfs, o))
            assert not os.path.exists(str(marker))          # before the escape: not visible
            os.mkdir("/escape-dir")
            os.chroot("/escape-dir")                        # cwd is still OUTSIDE the new root
            for _ in range(64):
                os.chdir("..")
            os.chroot(".")
            result = b"1" if os.path.exists(str(marker)) else b"0"
        finally:
            os.write(w, result)
            os._exit(0)
    os.close(w)
    result = os.read(r, 1)
    os.waitpid(pid, 0)
    return {b"1": True, b"0": False}[result]


def test_pivot_root_cannot_be_escaped(rootfs, tmp_path):
    assert _escape_attempt(rootfs, tmp_path, use_pivot_root=True) is False


def test_chroot_alone_can_be_escaped(rootfs, tmp_path):
    # the control experiment: the same escape against chroot DOES reach the host. If this ever
    # fails, the test above proves nothing.
    assert _escape_attempt(rootfs, tmp_path, use_pivot_root=False) is True
