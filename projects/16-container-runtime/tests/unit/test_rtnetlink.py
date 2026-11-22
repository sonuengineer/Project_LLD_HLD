"""rtnetlink encoding and decoding. The expected bytes are written out by hand from the kernel structs
(include/uapi/linux/netlink.h, rtnetlink.h, if_link.h, veth.h), not produced by the encoder itself."""
from __future__ import annotations

import errno
import ipaddress
import struct

import pytest

from minibox import rtnetlink as rt


def test_attr_is_padded_to_4_but_its_length_field_is_not():
    assert rt.attr(3, b"eth0\0") == b"\x09\x00\x03\x00" + b"eth0\0" + b"\0\0\0"
    assert rt.attr(1, b"veth") == b"\x08\x00\x01\x00veth"           # already aligned: no padding


def test_link_up_changes_only_the_up_flag():
    # family 0, pad, type 0, index 7, flags IFF_UP, change mask IFF_UP
    assert rt.link_up_body(7) == bytes([0, 0, 0, 0]) + b"\x07\0\0\0" + b"\x01\0\0\0" + b"\x01\0\0\0"


def test_add_address_body():
    body = rt.add_addr_body(5, ipaddress.IPv4Interface("10.200.0.2/30"))
    addr = b"\x0a\xc8\x00\x02"
    assert body == (bytes([2, 30, 0, 0]) + b"\x05\0\0\0"                  # AF_INET, /30, flags, scope, index
                    + b"\x08\x00\x02\x00" + addr                          # IFA_LOCAL
                    + b"\x08\x00\x01\x00" + addr)                         # IFA_ADDRESS


def test_message_header_counts_the_whole_message():
    msg = rt.message(rt.RTM_NEWLINK, rt.NLM_F_REQUEST | rt.NLM_F_ACK, 9, b"x" * 16)
    assert struct.unpack_from("=IHHII", msg) == (32, 16, 5, 9, 0)


def test_veth_body_nests_the_peer_with_its_namespace_pid():
    body = rt.veth_body("mbxtest", "eth0", 4242)
    assert body[:16] == bytes(16)                                         # host end: index 0 = create
    top = rt.parse_attrs(body[16:])
    assert top[0] == (rt.IFLA_IFNAME, b"mbxtest\0")
    assert top[1][0] == rt.IFLA_LINKINFO
    info = dict(rt.parse_attrs(top[1][1]))
    assert info[rt.IFLA_INFO_KIND] == b"veth"
    peer = dict(rt.parse_attrs(info[rt.IFLA_INFO_DATA]))[rt.VETH_INFO_PEER]
    assert peer[:16] == bytes(16)                                         # the peer's own ifinfomsg
    assert rt.parse_attrs(peer[16:]) == [(rt.IFLA_IFNAME, b"eth0\0"),
                                         (rt.IFLA_NET_NS_PID, struct.pack("=I", 4242))]
    assert len(body) % 4 == 0


@pytest.mark.parametrize("name", ["", "a" * 16, "a/b", " eth0"])
def test_bad_interface_names_are_refused(name):
    with pytest.raises(ValueError):
        rt.check_ifname(name)


def test_parse_attrs_rejects_a_length_past_the_end():
    with pytest.raises(ValueError):
        rt.parse_attrs(b"\x20\x00\x01\x00abcd")


def test_parse_messages_splits_a_datagram():
    data = rt.message(3, 2, 1, b"") + rt.message(2, 0, 2, b"abcd")
    assert rt.parse_messages(data) == [(3, 2, 1, b""), (2, 0, 2, b"abcd")]


class FakeSock:
    """Answers each request with the replies built by `reply(seq)`."""

    def __init__(self, reply):
        self.reply, self.sent, self.queue = reply, [], []

    def send(self, data):
        self.sent.append(data)
        seq = struct.unpack_from("=IHHII", data)[3]
        self.queue.extend(self.reply(seq))
        return len(data)

    def recv(self, _n):
        return self.queue.pop(0)

    def close(self):
        pass


def ack(seq, err=0):
    return rt.message(rt.NLMSG_ERROR, 0, seq, struct.pack("=i", err) + bytes(16))


def test_request_waits_for_its_own_ack_and_sets_request_and_ack_flags():
    sock = FakeSock(lambda seq: [ack(seq + 100, -1), ack(seq)])          # a stray reply first: ignored
    rt.Netlink(sock).set_up(3)
    flags = struct.unpack_from("=IHHII", sock.sent[0])[2]
    assert flags == rt.NLM_F_REQUEST | rt.NLM_F_ACK


def test_negative_error_becomes_oserror_with_errno():
    nl = rt.Netlink(FakeSock(lambda seq: [ack(seq, -errno.EEXIST)]))
    with pytest.raises(OSError) as e:
        nl.create_veth("mbxtest", "eth0", 1)
    assert e.value.errno == errno.EEXIST


def test_create_veth_asks_for_create_and_exclusive():
    sock = FakeSock(lambda seq: [ack(seq)])
    rt.Netlink(sock).create_veth("mbxtest", "eth0", 1)
    _len, mtype, flags, _seq, _pid = struct.unpack_from("=IHHII", sock.sent[0])
    assert mtype == rt.RTM_NEWLINK
    assert flags & rt.NLM_F_CREATE and flags & rt.NLM_F_EXCL


def test_delete_missing_link_is_ok_only_when_asked():
    nl = rt.Netlink(FakeSock(lambda seq: [ack(seq, -errno.ENODEV)]))
    nl.delete_link("mbxgone", missing_ok=True)
    with pytest.raises(OSError):
        nl.delete_link("mbxgone")


def test_ipv4_address_dump_skips_other_families_and_stops_at_done():
    def addr_msg(seq, family, ip, prefix, index):
        body = struct.pack("=BBBBI", family, prefix, 0, 0, index)
        if ip:
            body += rt.attr(rt.IFA_LOCAL, ipaddress.IPv4Address(ip).packed)
        return rt.message(rt.RTM_NEWADDR, rt.NLM_F_MULTI, seq, body)

    def reply(seq):
        return [addr_msg(seq, 2, "127.0.0.1", 8, 1) + addr_msg(seq, 10, None, 64, 2),
                addr_msg(seq, 2, "10.0.0.5", 24, 2) + rt.message(rt.NLMSG_DONE, rt.NLM_F_MULTI, seq, bytes(4))]

    sock = FakeSock(reply)
    got = rt.Netlink(sock).ipv4_addresses()
    assert got == [ipaddress.IPv4Interface("127.0.0.1/8"), ipaddress.IPv4Interface("10.0.0.5/24")]
    assert struct.unpack_from("=IHHII", sock.sent[0])[2] & rt.NLM_F_DUMP == rt.NLM_F_DUMP
