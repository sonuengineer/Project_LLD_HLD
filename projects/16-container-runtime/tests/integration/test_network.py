"""--net veth on a real kernel (stage 4a). Needs Linux, root and the alpine rootfs (busybox ip, ping, nc).

The host side is found through STATE/NAME/net.json, which minibox writes once the host end exists
(like `docker inspect`); that is how a test learns the addresses without guessing.
"""
from __future__ import annotations

import ipaddress
import json
import os
import signal
import socket
import subprocess
import time

import pytest


def host_links() -> list[str]:
    return sorted(n for n in os.listdir("/sys/class/net") if n.startswith("mbx"))


def wait_net_json(state_dir: str, name: str, proc: subprocess.Popen, timeout: float = 15) -> dict:
    path = os.path.join(state_dir, name, "net.json")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            pytest.fail(f"container exited before its network was up: {proc.communicate()}")
        try:
            with open(path) as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.05)
    pytest.fail(f"{path} never appeared")


def finish(proc: subprocess.Popen, stdin_text: str = "", timeout: float = 30) -> tuple[str, str]:
    out, err = proc.communicate(stdin_text, timeout=timeout)
    return out, err


def test_eth0_has_the_container_address_and_only_a_connected_route(box, tmp_path):
    stats = tmp_path / "stats.json"
    # (no /sys in the container: minibox mounts only /proc and a minimal /dev)
    r = box.run("ip -4 addr show dev eth0; echo ROUTES; ip -4 route; ip link show eth0 | grep -q 'state UP' && echo STATE=up",
                "--net", "veth", "--stats-file", str(stats))
    assert r.returncode == 0, r.stderr
    net = json.loads(stats.read_text())["net"]
    assert ipaddress.IPv4Interface(net["container_ip"]).network == ipaddress.IPv4Network(net["subnet"])
    assert f"inet {net['container_ip']}" in r.stdout
    routes = [line for line in r.stdout.split("ROUTES\n", 1)[1].splitlines() if line and not line.startswith("STATE=")]
    assert routes and all(line.startswith(net["subnet"]) for line in routes), routes    # no default route
    assert "STATE=up" in r.stdout


def test_veth_adds_exactly_one_interface(box):
    # the default (loopback only) is test_isolation.test_only_loopback_network_and_it_is_up
    r = box.run("tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '", "--net", "veth")
    assert r.returncode == 0 and sorted(r.stdout.split()) == ["eth0", "lo"], (r.stdout, r.stderr)


def test_container_reaches_the_host_end(box):
    p = box.popen("read HOST; ping -c 1 -W 2 $HOST >/dev/null && echo PING-OK", "--net", "veth", "--name", "nethost",
                  stdin=subprocess.PIPE)
    net = wait_net_json(box.state_dir, "nethost", p)
    out, err = finish(p, ipaddress.IPv4Interface(net["host_ip"]).ip.compressed + "\n")
    assert "PING-OK" in out, (out, err)


def test_host_reaches_a_tcp_server_in_the_container(box):
    p = box.popen("echo hello-from-box | nc -l -p 7070", "--net", "veth", "--name", "nettcp")
    ip = str(ipaddress.IPv4Interface(wait_net_json(box.state_dir, "nettcp", p)["container_ip"]).ip)
    deadline, data = time.monotonic() + 10, b""
    while time.monotonic() < deadline and not data:
        try:
            with socket.create_connection((ip, 7070), timeout=2) as s:
                data = s.recv(100)
        except (ConnectionRefusedError, socket.timeout):      # nc not listening yet: the container's kernel says RST
            time.sleep(0.05)
    finish(p)
    assert data == b"hello-from-box\n"


def test_nothing_beyond_the_host_end_is_routable(box):
    # 192.0.2.1 is TEST-NET-1 (documentation only). With no default route the kernel refuses at once:
    # no packet leaves the container, so there is nothing for the host to forward or NAT.
    r = box.run("ping -c 1 -W 1 192.0.2.1 2>&1; echo rc=$?", "--net", "veth")
    assert "Network unreachable" in r.stdout and "rc=0" not in r.stdout, r.stdout


def test_two_containers_get_different_subnets_and_cannot_reach_each_other(box):
    a = box.popen("read X", "--net", "veth", "--name", "neta", stdin=subprocess.PIPE)
    b = box.popen("read IP; ping -c 1 -W 1 $IP 2>&1; echo rc=$?", "--net", "veth", "--name", "netb", stdin=subprocess.PIPE)
    try:
        na = wait_net_json(box.state_dir, "neta", a)
        nb = wait_net_json(box.state_dir, "netb", b)
        assert na["subnet"] != nb["subnet"] and na["host_if"] != nb["host_if"]
        out, _ = finish(b, str(ipaddress.IPv4Interface(na["container_ip"]).ip) + "\n")
        assert "Network unreachable" in out and "rc=0" not in out, out
    finally:
        finish(a, "\n")


def test_host_end_is_deleted_when_the_container_exits(box, state_dir):
    before = host_links()
    r = box.run("true", "--net", "veth")
    assert r.returncode == 0, r.stderr
    assert host_links() == before
    assert os.listdir(state_dir) == []


def test_host_end_is_deleted_after_a_stop_signal(box, state_dir):
    p = box.popen("exec sleep 60", "--net", "veth", "--name", "netstop")
    net = wait_net_json(box.state_dir, "netstop", p)
    assert net["host_if"] in host_links()
    p.send_signal(signal.SIGTERM)                       # minibox -> INIT -> sleep
    assert p.wait(timeout=15) == 128 + signal.SIGTERM
    assert net["host_if"] not in host_links()
    assert os.listdir(state_dir) == []


def test_host_end_is_deleted_even_if_something_keeps_the_namespace_alive(box, state_dir):
    # The kernel only deletes the pair when the container's network namespace dies. Anything that holds
    # /proc/PID/ns/net open (nsenter, `ip netns`, a monitoring agent) keeps it alive after INIT exits;
    # minibox deletes its end itself, so the interface still goes away with the container.
    p = box.popen("read X", "--net", "veth", "--name", "netpin", stdin=subprocess.PIPE)
    net = wait_net_json(box.state_dir, "netpin", p)
    with open("/sys/fs/cgroup/minibox/netpin/cgroup.procs") as f:
        init_pid = int(f.read().split()[0])            # INIT joined first; its children come later
    pin = os.open(f"/proc/{init_pid}/ns/net", os.O_RDONLY)
    try:
        finish(p, "\n")
        assert p.returncode == 0
        assert net["host_if"] not in host_links()
    finally:
        os.close(pin)


def test_parallel_starts_get_distinct_subnets(box):
    names = [f"netpar{i}" for i in range(8)]
    procs = [box.popen("read X", "--net", "veth", "--name", n, stdin=subprocess.PIPE) for n in names]
    try:
        nets = [wait_net_json(box.state_dir, n, p) for n, p in zip(names, procs)]
        assert len({n["subnet"] for n in nets}) == len(names), [n["subnet"] for n in nets]
    finally:
        for p in procs:
            finish(p, "\n")


def test_command_not_found_with_network_still_cleans_up(box, state_dir):
    before = host_links()
    r = box.run(["/no/such/binary"], "--net", "veth")
    assert r.returncode == 127
    assert host_links() == before and os.listdir(state_dir) == []
