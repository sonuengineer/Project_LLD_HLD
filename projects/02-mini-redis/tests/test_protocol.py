import pytest

from minidis.protocol import OK, Parser, ProtocolError, RespError, RespSet, encode, encode_command


def test_partial_frames_are_buffered_until_complete():
    p = Parser()
    raw = encode_command([b"SET", b"key", b"hello world"])
    for i in range(len(raw) - 1):
        p.feed(raw[i:i + 1])
        assert p.get_command() is None
    p.feed(raw[-1:])
    assert p.get_command() == [b"SET", b"key", b"hello world"]
    assert p.pending == 0


def test_pipelined_commands_in_one_chunk():
    p = Parser()
    p.feed(encode_command([b"INCR", b"a"]) * 3 + encode_command([b"GET", b"a"]))
    cmds = []
    while (c := p.get_command()) is not None:
        cmds.append(c)
    assert cmds == [[b"INCR", b"a"]] * 3 + [[b"GET", b"a"]]


def test_binary_safe_values():
    p = Parser()
    value = b"a\r\nb\x00c"
    p.feed(encode_command([b"SET", b"k", value]))
    assert p.get_command()[2] == value


def test_inline_command():
    p = Parser()
    p.feed(b"PING\r\nSET a  1\r\n")
    assert p.get_command() == [b"PING"]
    assert p.get_command() == [b"SET", b"a", b"1"]


def test_malformed_input_raises():
    p = Parser()
    p.feed(b"*1\r\n:5\r\n")
    with pytest.raises(ProtocolError):
        p.get_command()


def test_bulk_length_limit():
    p = Parser()
    p.feed(b"*1\r\n$999999999999\r\n")
    with pytest.raises(ProtocolError):
        p.get_command()


def test_encode_resp2_and_resp3():
    assert encode(None, 2) == b"$-1\r\n" and encode(None, 3) == b"_\r\n"
    assert encode(OK) == b"+OK\r\n"
    assert encode(RespError("WRONGTYPE x")) == b"-WRONGTYPE x\r\n"
    assert encode(RespError("boom")) == b"-ERR boom\r\n"
    assert encode({b"f": b"v"}, 2) == b"*2\r\n$1\r\nf\r\n$1\r\nv\r\n"
    assert encode({b"f": b"v"}, 3) == b"%1\r\n$1\r\nf\r\n$1\r\nv\r\n"
    assert encode(RespSet([b"a"]), 3) == b"~1\r\n$1\r\na\r\n"
    assert encode(RespSet([b"a"]), 2) == b"*1\r\n$1\r\na\r\n"
    assert encode(True, 3) == b"#t\r\n" and encode(True, 2) == b":1\r\n"
