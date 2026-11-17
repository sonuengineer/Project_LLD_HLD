# Command Reference -- minidis

Protocol: RESP2 by default, RESP3 after `HELLO 3`. Any Redis client works. Errors use Redis prefixes
(`ERR`, `WRONGTYPE`, `READONLY`, `OOM`, `NOPROTO`).

| Group | Commands |
|---|---|
| Connection | `PING [msg]`, `ECHO`, `HELLO [2|3] [SETNAME n]`, `SELECT 0`, `CLIENT SETNAME/GETNAME/ID/LIST/SETINFO`, `QUIT` |
| Strings | `GET`, `SET k v [NX|XX] [EX s|PX ms|EXAT s|PXAT ms|KEEPTTL] [GET]`, `SETNX`, `MGET`, `MSET`, `INCR`, `DECR`, `INCRBY`, `DECRBY`, `APPEND`, `STRLEN`, `GETDEL` |
| Keys | `DEL`, `UNLINK`, `EXISTS`, `TYPE`, `EXPIRE`, `PEXPIRE`, `EXPIREAT`, `PEXPIREAT`, `TTL`, `PTTL`, `PERSIST`, `KEYS pattern`, `SCAN cursor [MATCH p] [COUNT n]`, `DBSIZE`, `FLUSHDB`, `FLUSHALL`, `RENAME` |
| Lists | `LPUSH`, `RPUSH`, `LPOP [count]`, `RPOP [count]`, `LLEN`, `LRANGE`, `LINDEX`, `LSET` |
| Sets | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SCARD`, `SINTER`, `SUNION`, `SDIFF` |
| Hashes | `HSET`, `HGET`, `HDEL`, `HGETALL`, `HEXISTS`, `HLEN`, `HKEYS`, `HVALS`, `HMGET`, `HINCRBY` |
| Persistence | `SAVE`, `BGSAVE`, `LASTSAVE`, `BGREWRITEAOF` |
| Replication | `REPLICAOF host port`, `REPLICAOF NO ONE`, `SYNC` (internal), `REPLCONF` (internal) |
| Server | `INFO [section]`, `DBSIZE`, `CONFIG GET pattern`, `CONFIG SET maxmemory|maxmemory-policy|appendfsync v`, `MEMORY USAGE key`, `MEMORY STATS`, `COMMAND COUNT`, `DEBUG SLEEP s` |

## TTL return values

`TTL`/`PTTL`: `-2` key missing, `-1` no expiry, otherwise remaining time (TTL rounds to nearest second).

## INFO sections

`server`, `clients`, `memory` (used_memory estimate, maxmemory, policy), `persistence`
(loaded_from, rdb_changes_since_last_save, rdb_bgsave_in_progress, aof_*), `stats` (expired_keys,
evicted_keys, keyspace_hits/misses, active_expire_cycles), `replication` (role, offsets, per-replica
lag_bytes), `keyspace`.

## Examples

```
$ redis-cli -p 6380 set session:42 alice EX 30
OK
$ redis-cli -p 6380 ttl session:42
(integer) 30
$ redis-cli -p 6380 lpush jobs a b
(integer) 2
$ redis-cli -p 6380 lpush session:42 x
(error) WRONGTYPE Operation against a key holding the wrong kind of value
```

## CLI / environment

`python -m minidis --host --port --dir --appendonly yes|no --appendfsync always|everysec|no --save "3600 1 300 100" --maxmemory BYTES --maxmemory-policy P --replicaof host:port`
(each also as `MINIDIS_*` env var; see `.env.example`).
