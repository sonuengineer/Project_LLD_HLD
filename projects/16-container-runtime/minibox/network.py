"""`--net veth`: one veth pair per container, host <-> container on a private /30, and nothing else.

    host netns                               container netns (INIT's)
    mbx1a2b3c4d  10.200.N.1/30  <-- veth -->  eth0  10.200.N.2/30
                                              lo    127.0.0.1

What this deliberately does NOT do: no bridge, no NAT, no default route, no iptables rule. The only
route in the container is the connected /30, so every other destination fails at once with
"Network unreachable" and no packet leaves the host. The host reaches the container (and the
container the host) only on the two /30 addresses, subject to the host's own INPUT rules.
Adding a bridge + MASQUERADE + a default route is the next step (README, "NOT implemented").

Order (container.run): INIT unshares its network namespace and says so on a pipe -> the host creates
the pair with the peer already inside INIT's namespace, addresses and raises its end, and sends the
/30 back -> INIT addresses and raises eth0 -> mounts, pivot_root, exec. On exit the host deletes its
end explicitly: the kernel would do it too, but asynchronously after the namespace dies.
"""
from __future__ import annotations

import ipaddress
import secrets
import socket
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterable

from .rtnetlink import Netlink

POOL = ipaddress.IPv4Network("10.200.0.0/16")
CONTAINER_IF = "eth0"
LOCK_FILE = "/run/minibox-net.lock"


@dataclass(frozen=True)
class VethLink:
    host_if: str
    subnet: ipaddress.IPv4Network

    @property
    def host_ip(self) -> ipaddress.IPv4Interface:
        return ipaddress.IPv4Interface((self.subnet[1], self.subnet.prefixlen))

    @property
    def container_ip(self) -> ipaddress.IPv4Interface:
        return ipaddress.IPv4Interface((self.subnet[2], self.subnet.prefixlen))

    def as_dict(self) -> dict:
        return {"host_if": self.host_if, "subnet": str(self.subnet), "host_ip": str(self.host_ip),
                "container_ip": str(self.container_ip), "container_if": CONTAINER_IF}


def pick_subnet(in_use: Iterable[ipaddress.IPv4Interface], pool: ipaddress.IPv4Network = POOL) -> ipaddress.IPv4Network:
    """The first /30 of the pool that overlaps no network the host already has an address in.

    Checking overlap (not just 'is this exact address taken') also means: if the host itself sits in a
    network that covers the pool (say 10.0.0.0/8), nothing is free and we refuse instead of creating a
    route that shadows part of the host's real network.
    """
    taken = [iface.network for iface in in_use]
    for net in pool.subnets(new_prefix=30):
        if not any(net.overlaps(t) for t in taken):
            return net
    raise RuntimeError(f"no free /30 left in {pool} (or the host already uses addresses in it)")


def new_host_ifname() -> str:
    return "mbx" + secrets.token_hex(4)     # 11 bytes, under IFNAMSIZ (15 + NUL)


@contextmanager
def _allocation_lock():
    """Two minibox processes starting at once must not pick the same /30: hold an flock from
    'list addresses' to 'host end has its address'."""
    import fcntl  # Linux only; imported here so pick_subnet stays unit-testable on Windows

    with open(LOCK_FILE, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def setup_host_side(init_pid: int) -> VethLink:
    """Runs in the host. INIT must already be in its own network namespace."""
    host_if = new_host_ifname()
    with _allocation_lock(), Netlink() as nl:
        subnet = pick_subnet(nl.ipv4_addresses())
        link = VethLink(host_if, subnet)
        nl.create_veth(host_if, CONTAINER_IF, init_pid)
        try:
            index = socket.if_nametoindex(host_if)
            nl.add_address(index, link.host_ip)
            nl.set_up(index)
        except BaseException:
            nl.delete_link(host_if, missing_ok=True)
            raise
    return link


def setup_container_side(subnet: ipaddress.IPv4Network) -> None:
    """Runs in INIT, inside the container's network namespace (the socket is opened there)."""
    link = VethLink("", subnet)
    with Netlink() as nl:
        index = socket.if_nametoindex(CONTAINER_IF)
        nl.add_address(index, link.container_ip)
        nl.set_up(index)


def remove_host_side(host_if: str) -> None:
    with Netlink() as nl:
        nl.delete_link(host_if, missing_ok=True)
