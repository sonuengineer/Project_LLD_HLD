import pytest

from minikafka.storage.log import Log, OffsetOutOfRange
from minikafka.storage.record import CorruptRecord, Record, decode_at


def items(n, start=0, size=50):
    return [(f"k{i}".encode(), f"v{i}".encode().ljust(size, b".")) for i in range(start, start + n)]


def test_record_roundtrip_and_null_key():
    for r in (Record(7, 1000, b"key", b"value"), Record(8, 1001, None, b"")):
        enc = r.encode()
        dec, end = decode_at(enc, 0)
        assert dec == r and end == len(enc)


def test_crc_detects_corruption():
    enc = bytearray(Record(1, 1, b"k", b"value").encode())
    enc[-1] ^= 0xFF
    with pytest.raises(CorruptRecord):
        decode_at(bytes(enc), 0)


def test_append_read_offsets_are_dense(tmp_path):
    log = Log(tmp_path)
    assert log.append(items(3)) == 0 and log.append(items(2, 3)) == 3
    recs = log.read(0)
    assert [r.offset for r in recs] == [0, 1, 2, 3, 4] and recs[4].key == b"k4"
    assert [r.offset for r in log.read(2, max_offset=4)] == [2, 3]     # max_offset = high watermark
    assert log.read(5) == []
    with pytest.raises(OffsetOutOfRange):
        log.read(6)


def test_segments_roll_and_reads_cross_segments(tmp_path):
    log = Log(tmp_path, segment_bytes=2000, index_interval_bytes=300)
    for i in range(0, 500, 10):
        log.append(items(10, i))
    assert len(log.segments) > 10
    assert len(list(tmp_path.glob("*.log"))) == len(log.segments)
    for start in (0, 1, 137, 249, 499):            # sparse index + scan finds every offset
        assert log.read(start, max_bytes=10)[0].offset == start
    assert [r.offset for r in log.read(95, max_bytes=10_000_000)] == list(range(95, 500))


def test_reopen_restores_state(tmp_path):
    log = Log(tmp_path, segment_bytes=2000)
    log.append(items(100))
    log.close()
    log2 = Log(tmp_path, segment_bytes=2000)
    assert log2.log_end_offset == 100 and log2.read(42, max_bytes=1)[0].value.startswith(b"v42")
    assert log2.append(items(1)) == 100


def test_recovery_truncates_torn_tail(tmp_path):
    log = Log(tmp_path)
    log.append(items(10))
    log.close()
    seg = sorted(tmp_path.glob("*.log"))[-1]
    with open(seg, "ab") as f:
        f.write(Record(10, 1, b"k", b"half-written").encode()[:-7])   # crash mid-write
    log2 = Log(tmp_path)
    assert log2.recovered_truncated_bytes > 0 and log2.log_end_offset == 10
    assert log2.append(items(1)) == 10                                  # appends continue cleanly


def test_recovery_stops_at_corrupted_record(tmp_path):
    log = Log(tmp_path)
    log.append(items(10))
    log.close()
    seg = sorted(tmp_path.glob("*.log"))[-1]
    data = bytearray(seg.read_bytes())
    data[len(data) // 2] ^= 0xFF                                        # bit rot in the middle
    seg.write_bytes(bytes(data))
    log2 = Log(tmp_path)
    assert 0 < log2.log_end_offset < 10                                 # everything after the bad record dropped


def test_retention_by_time_and_size(tmp_path):
    log = Log(tmp_path, segment_bytes=1000, retention_ms=60_000)
    log.append(items(30), timestamp_ms=1_000)          # old
    log.append(items(30, 30), timestamp_ms=1_000_000)  # new
    n = log.apply_retention(now_ms=1_000_000 + 1)
    assert n > 0 and log.log_start_offset > 0
    with pytest.raises(OffsetOutOfRange):
        log.read(0)
    assert log.read(log.log_start_offset)[0].offset == log.log_start_offset
    log_b = Log(tmp_path / "b", segment_bytes=1000, retention_bytes=3000)
    for i in range(0, 200, 10):          # batches never split across segments, so append in batches
        log_b.append(items(10, i))
    log_b.apply_retention()
    assert log_b.size_bytes < 3000 + 1000 * 2 and log_b.log_end_offset == 200


def test_active_segment_is_never_deleted(tmp_path):
    log = Log(tmp_path, retention_ms=1)
    log.append(items(5), timestamp_ms=1)
    assert log.apply_retention(now_ms=10**12) == 0 and log.log_end_offset == 5


def test_truncate_to_for_follower_divergence(tmp_path):
    log = Log(tmp_path, segment_bytes=1500)
    log.append(items(100))
    log.truncate_to(37)
    assert log.log_end_offset == 37 and log.read(36)[0].offset == 36
    assert log.append(items(1)) == 37
    log.truncate_to(0)
    assert log.log_end_offset == 0
