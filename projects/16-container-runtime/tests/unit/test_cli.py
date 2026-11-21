import pytest

from minibox import cli
from minibox.cgroups import Limits
from minibox.container import Config, container_env, exit_code_from_status


def test_full_run_command_line():
    a = cli.parse_args(["run", "--rootfs", "/img", "--hostname", "box1", "--memory", "64M", "--pids", "32",
                        "--cpus", "0.5", "--", "/bin/sh", "-c", "echo hi; exit 3"])
    assert a.cmd == "run" and a.rootfs == "/img" and a.hostname == "box1"
    assert a.limits == Limits(memory=64 << 20, pids=32, cpus=0.5)
    assert a.command == ["/bin/sh", "-c", "echo hi; exit 3"]
    assert a.overlay is True


def test_command_flags_after_double_dash_are_not_ours():
    a = cli.parse_args(["run", "--rootfs", "/img", "--", "ls", "--memory", "-la"])
    assert a.command == ["ls", "--memory", "-la"]
    assert a.limits == Limits()


def test_command_without_double_dash():
    a = cli.parse_args(["run", "--rootfs", "/img", "/bin/echo", "x"])
    assert a.command == ["/bin/echo", "x"]


def test_defaults():
    a = cli.parse_args(["run", "--rootfs", "/img", "--", "true"])
    assert a.hostname == "minibox" and a.state_dir == "/run/minibox" and a.name is None
    assert a.env == [] and a.workdir == "/" and a.stats_file is None


def test_no_overlay_and_env():
    a = cli.parse_args(["run", "--rootfs", "/img", "--no-overlay", "-e", "A=1", "--env", "B=x=y", "--", "env"])
    assert a.overlay is False and a.env == ["A=1", "B=x=y"]


@pytest.mark.parametrize("argv", [
    ["run", "--rootfs", "/img"],                                    # no command
    ["run", "--rootfs", "/img", "--"],                              # no command
    ["run", "--", "true"],                                          # no rootfs
    ["run", "--rootfs", "/img", "--memory", "lots", "--", "true"],
    ["run", "--rootfs", "/img", "--pids", "0", "--", "true"],
    ["run", "--rootfs", "/img", "--cpus", "0", "--", "true"],
    ["run", "--rootfs", "/img", "--cpus", "0.001", "--", "true"],   # below the kernel's 1 ms quota
    ["run", "--rootfs", "/img", "--hostname", "bad_name!", "--", "true"],
    ["run", "--rootfs", "/img", "--hostname", "-x", "--", "true"],
    ["run", "--rootfs", "/img", "--name", "../etc", "--", "true"],
    ["pull", "alpine"],                                             # no --dest
    ["pull", "alpine", "--dest", "d", "--platform", "linux"],
])
def test_bad_arguments_exit_2(argv, capsys):
    with pytest.raises(SystemExit) as e:
        cli.parse_args(argv)
    assert e.value.code == 2


def test_pull_platform():
    a = cli.parse_args(["pull", "alpine:3.20", "--dest", "d", "--platform", "linux/arm64/v8"])
    assert a.platform == ("linux", "arm64", "v8")
    assert cli.parse_args(["pull", "busybox", "--dest", "d"]).platform is None


@pytest.mark.parametrize("name", ["box1", "a", "web-01", "a.b.c", "x" * 63])
def test_good_hostnames(name):
    assert cli._hostname(name) == name


def test_container_env():
    cfg = Config(rootfs="/r", command=["sh"], hostname="box1", env=["FOO=bar", "PATH=/bin"])
    env = container_env(cfg)
    assert env["HOSTNAME"] == "box1" and env["FOO"] == "bar" and env["PATH"] == "/bin" and env["HOME"] == "/root"
    with pytest.raises(ValueError):
        container_env(Config(rootfs="/r", command=["sh"], env=["NOEQUALS"]))


def test_host_environment_does_not_leak_in(monkeypatch):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "nope")
    assert "AWS_SECRET_ACCESS_KEY" not in container_env(Config(rootfs="/r", command=["sh"]))


@pytest.mark.skipif(not hasattr(__import__("os"), "WIFEXITED"), reason="POSIX wait status encoding")
def test_exit_code_from_status():
    # raw wait statuses: exit code in the high byte, killing signal in the low 7 bits
    assert exit_code_from_status(7 << 8) == 7
    assert exit_code_from_status(0) == 0
    assert exit_code_from_status(9) == 128 + 9       # SIGKILL -> 137, like docker
    assert exit_code_from_status(15) == 128 + 15     # SIGTERM -> 143
