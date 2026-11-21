import os

import pytest

from minibox import cgroups
from minibox.cgroups import Cgroup, Limits, format_cpu_max, parse_cpu_max, parse_flat_keyed, parse_limit, parse_size


@pytest.mark.parametrize("text,expected", [
    ("64M", 64 * 1024 * 1024), ("64m", 64 << 20), ("512k", 512 << 10), ("1G", 1 << 30), ("1048576", 1048576),
    ("1.5G", 3 << 29), ("64MiB", 64 << 20), ("64MB", 64 << 20), (" 2K ", 2048),
])
def test_parse_size(text, expected):
    assert parse_size(text) == expected


@pytest.mark.parametrize("text", ["", "abc", "-1M", "0", "1.3", "10X", "M"])
def test_parse_size_rejects(text):
    with pytest.raises(ValueError):
        parse_size(text)


@pytest.mark.parametrize("cpus,expected", [(0.5, "50000 100000"), (1, "100000 100000"), (2.5, "250000 100000"),
                                           (0.01, "1000 100000"), (None, "max 100000")])
def test_format_cpu_max(cpus, expected):
    assert format_cpu_max(cpus) == expected


def test_format_cpu_max_rejects_tiny_and_negative():
    with pytest.raises(ValueError):
        format_cpu_max(0.005)          # 500 us quota < kernel minimum of 1000 us
    with pytest.raises(ValueError):
        format_cpu_max(0)
    with pytest.raises(ValueError):
        format_cpu_max(-1)


def test_parse_cpu_max_round_trip():
    assert parse_cpu_max("50000 100000") == (50000, 100000)
    assert parse_cpu_max("max 100000\n") == (None, 100000)
    assert parse_cpu_max(format_cpu_max(0.25)) == (25000, 100000)
    with pytest.raises(ValueError):
        parse_cpu_max("50000")


def test_parse_limit():
    assert parse_limit("max\n") is None
    assert parse_limit("67108864\n") == 67108864


def test_parse_flat_keyed_memory_events():
    text = "low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n"
    assert parse_flat_keyed(text) == {"low": 0, "high": 0, "max": 12, "oom": 1, "oom_kill": 1, "oom_group_kill": 0}


def test_parse_flat_keyed_cpu_stat():
    text = ("usage_usec 1500321\nuser_usec 1500000\nsystem_usec 321\nnr_periods 30\nnr_throttled 29\n"
            "throttled_usec 1459000\nnr_bursts 0\nburst_usec 0\n")
    d = parse_flat_keyed(text)
    assert d["nr_throttled"] == 29 and d["throttled_usec"] == 1459000


def test_parse_flat_keyed_rejects_garbage():
    with pytest.raises(ValueError):
        parse_flat_keyed("novalue\n")


def test_limits_writes_order_and_values():
    w = Limits(memory=64 << 20, pids=32, cpus=0.5).writes()
    assert w == [("memory.max", "67108864"), ("memory.swap.max", "0"), ("pids.max", "32"),
                 ("cpu.max", "50000 100000")]


def test_limits_none_writes_nothing():
    assert Limits().writes() == []


def test_memory_limit_always_disables_swap():
    # without memory.swap.max = 0 a host with swap would swap the container instead of OOM-killing it
    assert ("memory.swap.max", "0") in Limits(memory=1 << 20).writes()


def test_limits_reject_zero_pids():
    with pytest.raises(ValueError):
        Limits(pids=0).writes()


@pytest.mark.parametrize("name", ["", "..", ".", "a/b", "x" * 65, "has space"])
def test_cgroup_name_rejected(name):
    with pytest.raises(ValueError):
        Cgroup(name)


def make_fake_root(tmp_path, controllers="cpu memory pids io"):
    root = tmp_path / "cg"
    root.mkdir()
    (root / "cgroup.subtree_control").write_text(controllers + "\n")
    return root


def test_create_writes_limits_into_a_leaf_on_a_fake_root(tmp_path, monkeypatch):
    # A plain directory stands in for /sys/fs/cgroup: we check WHICH files get written.
    root = make_fake_root(tmp_path)
    cg = Cgroup("box1", root=str(root))
    cg.create(Limits(memory=64 << 20, pids=32, cpus=0.5))
    parent = root / "minibox"
    assert (parent / "cgroup.subtree_control").read_text() == "+cpu +memory +pids"
    assert (parent / "box1" / "memory.max").read_text() == "67108864"
    assert (parent / "box1" / "memory.swap.max").read_text() == "0"
    assert (parent / "box1" / "pids.max").read_text() == "32"
    assert (parent / "box1" / "cpu.max").read_text() == "50000 100000"


def test_create_refuses_existing_name(tmp_path):
    root = make_fake_root(tmp_path)
    Cgroup("box1", root=str(root)).create(Limits())
    with pytest.raises(FileExistsError):
        Cgroup("box1", root=str(root)).create(Limits())


def test_create_refuses_when_root_lacks_controllers(tmp_path):
    root = make_fake_root(tmp_path, controllers="cpu io")
    with pytest.raises(RuntimeError, match="memory"):
        Cgroup("box1", root=str(root)).create(Limits())
    assert not (root / "minibox").exists()


def test_stats_reads_counters(tmp_path):
    root = make_fake_root(tmp_path)
    cg = Cgroup("box1", root=str(root))
    cg.create(Limits(pids=8))
    leaf = root / "minibox" / "box1"
    (leaf / "memory.events").write_text("oom 1\noom_kill 1\n")
    (leaf / "pids.events").write_text("max 17\n")
    (leaf / "memory.peak").write_text("67108864\n")
    s = cg.stats()
    assert s["limits"]["pids.max"] == "8"
    assert s["counters"]["memory.events"]["oom_kill"] == 1
    assert s["counters"]["pids.events"]["max"] == 17
    assert s["counters"]["memory.peak"] == 67108864


def test_remove_keeps_parent_used_by_another_container(tmp_path, monkeypatch):
    root = make_fake_root(tmp_path)
    a, b = Cgroup("a", root=str(root)), Cgroup("b", root=str(root))
    a.create(Limits())
    b.create(Limits())
    # real cgroup dirs can be rmdir'ed with their interface files in them; a fake one cannot
    for leaf in ("a", "b"):
        for f in os.listdir(root / "minibox" / leaf):
            os.unlink(root / "minibox" / leaf / f)
    os.unlink(root / "minibox" / "cgroup.subtree_control")
    a.remove()
    assert not (root / "minibox" / "a").exists()
    assert (root / "minibox" / "b").exists()
    b.remove()
    assert not (root / "minibox").exists()


def test_default_paths():
    cg = Cgroup("x")
    assert cg.path == os.path.join("/sys/fs/cgroup", "minibox", "x")
    assert cgroups.CPU_PERIOD_US == 100_000
