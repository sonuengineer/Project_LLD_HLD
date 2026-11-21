"""Stage 3: the image is a read-only lower layer; each container writes into its own upper dir,
which is thrown away when it exits."""
from __future__ import annotations

import os
import shutil
import subprocess

import pytest


def test_writes_do_not_reach_the_image_and_vanish(box, rootfs):
    r = box.run("echo junk > /root/new-file; rm /etc/motd; echo changed >> /etc/hostname; "
                "ls /root/new-file; test -e /etc/motd || echo motd-gone")
    assert r.returncode == 0, r.stderr
    assert "motd-gone" in r.stdout
    assert not os.path.exists(os.path.join(rootfs, "root", "new-file"))
    assert os.path.exists(os.path.join(rootfs, "etc", "motd"))
    assert "changed" not in open(os.path.join(rootfs, "etc", "hostname")).read()
    # and the next container starts from the clean image again
    r2 = box.run("test -e /root/new-file && echo LEAKED; test -e /etc/motd && echo motd-back")
    assert r2.stdout.split() == ["motd-back"]


def test_deletion_is_recorded_as_an_overlay_whiteout(box, state_dir):
    # while the container runs, its upper dir holds a 0/0 character device for the deleted file:
    # overlayfs's own whiteout format (an image layer tar uses .wh. files instead)
    p = box.popen("rm /etc/motd; echo ready; read x", "--name", "wh", stdin=subprocess.PIPE)
    try:
        assert p.stdout.readline().strip() == "ready"
        st = os.lstat(os.path.join(state_dir, "wh", "upper", "etc", "motd"))
        import stat
        assert stat.S_ISCHR(st.st_mode) and os.major(st.st_rdev) == 0 and os.minor(st.st_rdev) == 0
    finally:
        p.communicate("\n", timeout=10)
    assert not os.path.exists(os.path.join(state_dir, "wh"))


def test_two_containers_do_not_see_each_others_writes(box):
    a = box.popen("echo A > /shared; echo ready; read x", "--name", "ov-a", stdin=subprocess.PIPE)
    try:
        assert a.stdout.readline().strip() == "ready"
        r = box.run("cat /shared 2>&1 || echo absent", "--name", "ov-b")
        assert "absent" in r.stdout
    finally:
        a.communicate("\n", timeout=10)


def test_no_overlay_writes_into_the_rootfs(box, rootfs, tmp_path):
    copy = tmp_path / "rw-rootfs"
    shutil.copytree(rootfs, copy, symlinks=True)
    box.rootfs = str(copy)
    r = box.run("echo kept > /root/persisted", "--no-overlay")
    assert r.returncode == 0, r.stderr
    assert (copy / "root" / "persisted").read_text() == "kept\n"
    assert not (copy / ".oldroot").exists()          # pivot_root's put_old was removed again


def test_image_rootfs_is_unchanged_after_many_runs(box, rootfs):
    def snapshot():
        out = []
        for dp, dns, fns in os.walk(rootfs):
            for n in sorted(dns + fns):
                p = os.path.join(dp, n)
                st = os.lstat(p)
                out.append((p, st.st_mode, st.st_size, st.st_mtime_ns))
        return sorted(out)
    before = snapshot()
    for cmd in ("touch /etc/x", "rm -rf /usr/share", "mkdir -p /var/new/dir", "chmod 777 /bin"):
        assert box.run(cmd).returncode == 0
    assert snapshot() == before


@pytest.mark.network
def test_pull_alpine_from_docker_hub(tmp_path):
    from minibox import registry
    s = registry.pull("alpine:3.20", str(tmp_path / "img"), log=lambda m: None)
    root = tmp_path / "img" / "rootfs"
    assert (root / "etc" / "alpine-release").read_text().startswith("3.20")
    assert os.readlink(root / "bin" / "sh") == "/bin/busybox"
    assert s["layers"] >= 1 and s["manifest_digest"].startswith("sha256:")
