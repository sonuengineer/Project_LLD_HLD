"""rtnetlink: the kernel interface behind `ip link` and `ip addr`, over a plain AF_NETLINK socket.

Every request is one netlink message:

    nlmsghdr   (16 bytes: length, type, flags, sequence number, port id)
    family header (ifinfomsg for links, ifaddrmsg for addresses)
    attributes (rtattr: 2-byte length, 2-byte type, payload, padded to 4 bytes; attributes nest)

The kernel answers a request that has NLM_F_ACK with an NLMSG_ERROR message whose error field is 0 on
success or -errno on failure. A dump (NLM_F_DUMP) answers with many messages and then NLMSG_DONE.

Only what minibox needs is here: create a veth pair with one end in another network namespace, add an
IPv4 address, set a link up, delete a link, list IPv4 addresses. The encoders are pure functions so
they are unit tested on any OS; the kernel is the real check (tests/integration/test_network.py).
"""
from __future__ import annotations

import errno
import ipaddress
import os
import socket
import struct

NETLINK_ROUTE = 0

NLMSG_ERROR, NLMSG_DONE = 2, 3
RTM_NEWLINK, RTM_DELLINK, RTM_NEWADDR, RTM_GETADDR = 16, 17, 20, 22

NLM_F_REQUEST, NLM_F_MULTI, NLM_F_ACK = 0x1, 0x2, 0x4
NLM_F_EXCL, NLM_F_CREATE, NLM_F_DUMP = 0x200, 0x400, 0x300

IFLA_IFNAME, IFLA_LINKINFO, IFLA_NET_NS_PID = 3, 18, 19
IFLA_INFO_KIND, IFLA_INFO_DATA = 1, 2
VETH_INFO_PEER = 1
IFA_ADDRESS, IFA_LOCAL = 1, 2
IFF_UP = 0x1
NLA_TYPE_MASK = 0x3FFF          # the top two bits of rtattr.type are flags (NESTED, NET_BYTEORDER)

NLMSGHDR = struct.Struct("=IHHII")    # len, type, flags, seq, pid
IFINFOMSG = struct.Struct("=BxHiII")  # family, pad, type, index, flags, change
IFADDRMSG = struct.Struct("=BBBBI")   # family, prefixlen, flags, scope, index
RTATTR = struct.Struct("=HH")         # len, type
NLMSGERR = struct.Struct("=i")        # error (0 = ACK), followed by the request's header


def align4(n: int) -> int:
    return (n + 3) & ~3


# ------------------------------------------------------------------------------------------ encoding

def attr(type_: int, payload: bytes) -> bytes:
    """One rtattr. Its length field excludes the padding; the next attribute starts 4-aligned."""
    length = RTATTR.size + len(payload)
    return RTATTR.pack(length, type_) + payload + b"\0" * (align4(length) - length)


def attr_str(type_: int, text: str) -> bytes:
    return attr(type_, text.encode() + b"\0")


def attr_u32(type_: int, value: int) -> bytes:
    return attr(type_, struct.pack("=I", value))


def message(type_: int, flags: int, seq: int, body: bytes) -> bytes:
    return NLMSGHDR.pack(NLMSGHDR.size + len(body), type_, flags, seq, 0) + body


def check_ifname(name: str) -> str:
    if not 0 < len(name.encode()) <= 15 or "/" in name or name.strip() != name:
        raise ValueError(f"bad interface name {name!r} (1-15 bytes, IFNAMSIZ is 16 with the NUL)")
    return name


def veth_body(name: str, peer: str, peer_netns_pid: int) -> bytes:
    """RTM_NEWLINK body for `ip link add NAME type veth peer name PEER netns PID`.

    The peer is described by a second ifinfomsg + attributes nested inside
    IFLA_LINKINFO -> IFLA_INFO_DATA -> VETH_INFO_PEER. IFLA_NET_NS_PID there makes the kernel create
    the peer directly in that process's network namespace, so it never exists in the host's.
    """
    peer_part = (IFINFOMSG.pack(socket.AF_UNSPEC, 0, 0, 0, 0)
                 + attr_str(IFLA_IFNAME, check_ifname(peer))
                 + attr_u32(IFLA_NET_NS_PID, peer_netns_pid))
    linkinfo = attr(IFLA_INFO_KIND, b"veth") + attr(IFLA_INFO_DATA, attr(VETH_INFO_PEER, peer_part))
    return (IFINFOMSG.pack(socket.AF_UNSPEC, 0, 0, 0, 0)
            + attr_str(IFLA_IFNAME, check_ifname(name))
            + attr(IFLA_LINKINFO, linkinfo))


def link_up_body(index: int) -> bytes:
    """RTM_NEWLINK on an existing index: change only IFF_UP (the 'change' mask), set it to 1."""
    return IFINFOMSG.pack(socket.AF_UNSPEC, 0, index, IFF_UP, IFF_UP)


def del_link_body(name: str) -> bytes:
    """RTM_DELLINK by name (index 0). Deleting one end of a veth pair deletes both ends."""
    return IFINFOMSG.pack(socket.AF_UNSPEC, 0, 0, 0, 0) + attr_str(IFLA_IFNAME, check_ifname(name))


def add_addr_body(index: int, iface: ipaddress.IPv4Interface) -> bytes:
    """RTM_NEWADDR for `ip addr add A/P dev X`. On a point-to-point-less link LOCAL and ADDRESS are equal;
    the kernel adds the connected route for the prefix by itself once the link is up."""
    packed = iface.ip.packed
    return (IFADDRMSG.pack(socket.AF_INET, iface.network.prefixlen, 0, 0, index)
            + attr(IFA_LOCAL, packed) + attr(IFA_ADDRESS, packed))


# ------------------------------------------------------------------------------------------ decoding

def parse_attrs(data: bytes) -> list[tuple[int, bytes]]:
    out, off = [], 0
    while off + RTATTR.size <= len(data):
        length, type_ = RTATTR.unpack_from(data, off)
        if length < RTATTR.size or off + length > len(data):
            raise ValueError(f"bad rtattr length {length} at offset {off}")
        out.append((type_ & NLA_TYPE_MASK, data[off + RTATTR.size: off + length]))
        off += align4(length)
    return out


def parse_messages(data: bytes) -> list[tuple[int, int, int, bytes]]:
    """(type, flags, seq, payload) for every netlink message in one datagram."""
    out, off = [], 0
    while off + NLMSGHDR.size <= len(data):
        length, type_, flags, seq, _pid = NLMSGHDR.unpack_from(data, off)
        if length < NLMSGHDR.size or off + length > len(data):
            raise ValueError(f"bad nlmsg length {length} at offset {off}")
        out.append((type_, flags, seq, data[off + NLMSGHDR.size: off + length]))
        off += align4(length)
    return out


def parse_ipv4_addr(payload: bytes) -> tuple[int, ipaddress.IPv4Interface] | None:
    family, prefixlen, _flags, _scope, index = IFADDRMSG.unpack_from(payload)
    if family != socket.AF_INET:
        return None
    attrs = dict(parse_attrs(payload[IFADDRMSG.size:]))
    raw = attrs.get(IFA_LOCAL) or attrs.get(IFA_ADDRESS)
    if raw is None or len(raw) != 4:
        return None
    return index, ipaddress.IPv4Interface((ipaddress.IPv4Address(raw), prefixlen))


def error_code(payload: bytes) -> int:
    return -NLMSGERR.unpack_from(payload)[0]


# ------------------------------------------------------------------------------------------ socket

class Netlink:
    """One NETLINK_ROUTE socket, in the network namespace of the process that opened it."""

    def __init__(self, sock=None):
        if sock is None:
            sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_ROUTE)
            sock.bind((0, 0))                  # port id 0: the kernel assigns one
        self.sock = sock
        self.seq = 0

    def close(self) -> None:
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _send(self, type_: int, flags: int, body: bytes) -> int:
        self.seq += 1
        self.sock.send(message(type_, flags | NLM_F_REQUEST, self.seq, body))
        return self.seq

    def request(self, type_: int, flags: int, body: bytes) -> None:
        """Send one request and wait for its ACK; a negative error becomes OSError(errno)."""
        seq = self._send(type_, flags | NLM_F_ACK, body)
        while True:
            for mtype, _f, mseq, payload in parse_messages(self.sock.recv(65536)):
                if mseq != seq or mtype != NLMSG_ERROR:
                    continue
                err = error_code(payload)
                if err:
                    raise OSError(err, f"rtnetlink: {os.strerror(err)}")
                return

    def dump(self, type_: int, body: bytes) -> list[tuple[int, bytes]]:
        seq = self._send(type_, NLM_F_DUMP, body)
        out = []
        while True:
            for mtype, _f, mseq, payload in parse_messages(self.sock.recv(65536)):
                if mseq != seq:
                    continue
                if mtype == NLMSG_DONE:
                    return out
                if mtype == NLMSG_ERROR:
                    err = error_code(payload)
                    raise OSError(err, f"rtnetlink dump: {os.strerror(err)}")
                out.append((mtype, payload))

    # -- the operations minibox uses

    def create_veth(self, name: str, peer: str, peer_netns_pid: int) -> None:
        self.request(RTM_NEWLINK, NLM_F_CREATE | NLM_F_EXCL, veth_body(name, peer, peer_netns_pid))

    def set_up(self, index: int) -> None:
        self.request(RTM_NEWLINK, 0, link_up_body(index))

    def add_address(self, index: int, iface: ipaddress.IPv4Interface) -> None:
        self.request(RTM_NEWADDR, NLM_F_CREATE | NLM_F_EXCL, add_addr_body(index, iface))

    def delete_link(self, name: str, missing_ok: bool = False) -> None:
        try:
            self.request(RTM_DELLINK, 0, del_link_body(name))
        except OSError as e:
            if not (missing_ok and e.errno == errno.ENODEV):    # already gone
                raise

    def ipv4_addresses(self) -> list[ipaddress.IPv4Interface]:
        out = []
        for _t, payload in self.dump(RTM_GETADDR, IFADDRMSG.pack(socket.AF_INET, 0, 0, 0, 0)):
            parsed = parse_ipv4_addr(payload)
            if parsed:
                out.append(parsed[1])
        return out
