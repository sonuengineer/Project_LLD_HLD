# Interview Preparation -- minidis

Question bank: `interview/data/p02-mini-redis/` (validated by `python interview/validate.py --only p02-mini-redis`),
browsable in the portfolio website.

## Stories to tell without notes

1. **Wire compatible**: the test suite uses the official redis-py client; redis-cli and
   redis-benchmark work too. redis-py 8 forced RESP3 support (HELLO 3).
2. **Atomic without locks**: sync handlers on one event loop; 50x200 INCR = 10000; the flip side is
   one slow command blocking everyone.
3. **Durability is a dial**: snapshot vs AOF always/everysec/no, group commit, absolute TTLs in
   AOF, truncated-tail recovery, atomic rename + CRC for snapshots.
4. **Replication details that matter**: replicas don't expire keys themselves; the DEL leak bug
   the tests caught; async replication data-loss window.
5. **Performance investigation**: writes 2-6x slower than reads -> isolate replica -> batch the
   replication stream -> ~3x faster pipelined writes, measured with redis-benchmark vs real Redis.
