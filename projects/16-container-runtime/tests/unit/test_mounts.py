import os

import pytest

from minibox import libc, mounts
from minibox.mounts import Mkdir, Mknod, Mount, OverlayDirs, Symlink, build_plan, overlay_options

ROOT = os.path.join(os.sep, "srv", "img", "rootfs")


def overlay():
    st = os.path.join(os.sep, "run", "minibox", "c1")
    return OverlayDirs(lower=ROOT, upper=os.path.join(st, "upper"), work=os.path.join(st, "work"),
                       merged=os.path.join(st, "merged"))


def mounts_of(plan):
    return [s for s in plan.steps if isinstance(s, Mount)]


def test_first_step_makes_everything_private():
    # without this, on a systemd host (/ is 'shared') our mounts would propagate back to the host
    for plan in (build_plan(ROOT), build_plan(ROOT, overlay())):
        first = plan.steps[0]
        assert first == Mount(None, "/", None, libc.MS_REC | libc.MS_PRIVATE)


def test_bind_root_when_no_overlay():
    plan = build_plan(ROOT)
    assert plan.new_root == ROOT
    assert plan.steps[1] == Mount(ROOT, ROOT, None, libc.MS_BIND | libc.MS_REC)


def test_overlay_root():
    o = overlay()
    plan = build_plan(ROOT, o)
    assert plan.new_root == o.merged
    m = plan.steps[1]
    assert (m.source, m.target, m.fstype) == ("overlay", o.merged, "overlay")
    assert m.data == f"lowerdir={ROOT},upperdir={o.upper},workdir={o.work}"


def test_overlay_lower_must_be_rootfs():
    o = OverlayDirs(lower="/other", upper="/u", work="/w", merged="/m")
    with pytest.raises(ValueError):
        build_plan(ROOT, o)


@pytest.mark.parametrize("bad", ["/a,b", "/a:b"])
def test_overlay_rejects_separator_chars(bad):
    with pytest.raises(ValueError):
        overlay_options(OverlayDirs(lower=bad, upper="/u", work="/w", merged="/m"))


def test_proc_is_mounted_inside_new_root_with_safe_flags():
    plan = build_plan(ROOT, overlay())
    proc = [m for m in mounts_of(plan) if m.fstype == "proc"]
    assert len(proc) == 1
    assert proc[0].target == os.path.join(plan.new_root, "proc")
    assert proc[0].flags == libc.MS_NOSUID | libc.MS_NOEXEC | libc.MS_NODEV


def test_proc_can_be_left_out():
    assert not [m for m in mounts_of(build_plan(ROOT, mount_proc=False)) if m.fstype == "proc"]


def test_root_before_proc_before_dev_and_oldroot_last():
    plan = build_plan(ROOT, overlay())
    kinds = [m.fstype or ("bind" if m.flags & libc.MS_BIND else "private") for m in mounts_of(plan)]
    assert kinds == ["private", "overlay", "proc", "tmpfs", "devpts", "tmpfs"]
    assert plan.steps[-1] == Mkdir(os.path.join(plan.new_root, mounts.OLD_ROOT), 0o700)


def test_dev_has_exactly_the_minimal_devices():
    plan = build_plan(ROOT)
    nodes = {os.path.basename(s.path): (s.major, s.minor) for s in plan.steps if isinstance(s, Mknod)}
    assert nodes == {"null": (1, 3), "zero": (1, 5), "full": (1, 7), "random": (1, 8), "urandom": (1, 9),
                     "tty": (5, 0)}
    # every node is created AFTER the tmpfs on /dev (otherwise it would land in the image itself)
    dev_tmpfs = next(i for i, s in enumerate(plan.steps) if isinstance(s, Mount) and s.target.endswith("dev"))
    first_node = next(i for i, s in enumerate(plan.steps) if isinstance(s, Mknod))
    assert dev_tmpfs < first_node


def test_dev_symlinks():
    plan = build_plan(ROOT)
    links = {os.path.basename(s.path): s.target for s in plan.steps if isinstance(s, Symlink)}
    assert links["fd"] == "/proc/self/fd"
    assert links["stdin"] == "/proc/self/fd/0" and links["stderr"] == "/proc/self/fd/2"


def test_every_target_is_inside_new_root():
    for plan in (build_plan(ROOT), build_plan(ROOT, overlay())):
        for s in plan.steps[1:]:
            target = s.target if isinstance(s, Mount) else s.path
            assert target == plan.new_root or target.startswith(plan.new_root + os.sep), s


def test_mount_flag_values_match_linux_headers():
    assert (libc.MS_BIND, libc.MS_REC, libc.MS_PRIVATE, libc.MNT_DETACH) == (4096, 16384, 262144, 2)
    assert libc.SYS_PIVOT_ROOT["aarch64"] == 41 and libc.SYS_PIVOT_ROOT["x86_64"] == 155
