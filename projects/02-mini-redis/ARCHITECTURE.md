# Architecture -- minidis

```
minidis/
  __main__.py          CLI entry (python -m minidis)
  config.py            ServerConfig + argparse/env parsing
  protocol.py          RESP2/RESP3 incremental parser + encoder
  server.py            TCP server, dispatch, propagation, cron, INFO, BGSAVE/AOF orchestration
  keyspace.py          storage engine: dict + expires + LRU order + memory accounting + eviction
  randomset.py         O(1) random sampling set (active expiry, sampled eviction)
  commands/            one module per data type; handlers are SYNC functions (atomicity)
  persistence/snapshot.py   binary snapshot with CRC32, atomic rename
  persistence/aof.py        append-only file, fsync policies, replay, rewrite
  replication.py       replica-side link (SYNC, stream apply, ACK, reconnect with backoff)
```

## Component diagram

```mermaid
flowchart LR
  subgraph Clients
    C1[redis-py] & C2[redis-cli] & C3[redis-benchmark]
  end
  C1 & C2 & C3 -- RESP over TCP --> S[Server._handle_client<br/>one asyncio task per connection]
  S --> P[Parser<br/>incremental]
  P --> D[Server.execute<br/>arity / READONLY / OOM checks]
  D --> H[Command handler<br/>sync, atomic]
  H --> K[(Keyspace<br/>data, expires, sizes)]
  D -- write commands --> PR[_propagate]
  PR --> AOF[(appendonly.aof)]
  PR --> RB[replication buffer<br/>flushed once per loop tick]
  RB --> R1[Replica]
  CR[cron 10Hz] --> K
  CR --> AOF
  CR --> SNAP[(dump.mdb)]
```

## Request lifecycle (one pipelined batch)

```mermaid
sequenceDiagram
  participant C as Client
  participant L as Connection task
  participant E as execute()
  participant K as Keyspace
  participant A as AOF
  participant R as Replicas
  C->>L: bytes (may hold 1..N commands, or half of one)
  L->>L: parser.feed(); loop get_command()
  loop each complete command
    L->>E: execute(args)
    E->>K: handler mutates state (no await = atomic)
    E->>A: append(encoded command) [write cmds]
    E->>R: queue for batched send [write cmds]
  end
  alt appendfsync = always
    L->>A: fsync (group commit for the whole batch)
  else
    L->>A: flush to OS
  end
  L-->>C: all replies in one write
```

## Why single-threaded is fast enough (and correct)

- The event loop runs one handler at a time and handlers never `await`, so no locks are needed and
  every command is atomic -- the same reason Redis is single-threaded for command execution.
- I/O waiting (sockets, fsync in `everysec`, snapshot writes) happens off the critical path.
- The cost: one slow command blocks everyone (`test_slow_command_blocks_all_clients` demonstrates it).

## Persistence flow

```mermaid
flowchart TD
  W[write command] --> AOFB[AOF buffer]
  AOFB -->|always| FS1[fsync before reply]
  AOFB -->|everysec| FS2[fsync in thread every 1s]
  AOFB -->|no| OS[OS decides]
  T[save rules / SAVE / BGSAVE] --> DUMP[serialize keyspace in loop]
  DUMP --> TMP[write temp file in thread + fsync]
  TMP --> REN[os.replace -> dump.mdb]
  RW[BGREWRITEAOF] --> MIN[minimal commands in loop]
  MIN --> THR[write + fsync in thread]
  THR --> TAIL[append rewrite buffer]
  TAIL --> SWAP[atomic swap]
  START[startup] --> Q{AOF enabled and exists?}
  Q -- yes --> REPLAY[replay AOF; cut truncated tail]
  Q -- no --> LOAD[load snapshot if present]
```
