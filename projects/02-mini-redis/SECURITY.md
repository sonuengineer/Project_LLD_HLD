# Security -- minidis

minidis has **no authentication, no ACLs and no TLS**, exactly like a default Redis before 6.0.
It must therefore only listen on localhost or a private network.

| Threat | Current mitigation | Production fix |
|---|---|---|
| Anyone who can reach the port can read/write/flush data | default bind `127.0.0.1`; Docker compose publishes only on `127.0.0.1` | `AUTH` + ACL users, network policies |
| Sniffing on the wire | none | TLS (asyncio `start_server(ssl=...)`) |
| Memory exhaustion by a client sending huge bulk lengths | `MAX_BULK_LEN` 512MB, `MAX_MULTIBULK_LEN` 1M, inline limit 64KB | lower limits, per-client query buffer limit |
| Memory exhaustion by data volume | `maxmemory` + eviction policies | same + alerts on used_memory |
| Slow replica / slow reader growing output buffers | replica buffer limit 64MB; `drain()` backpressure for clients | per-class client output buffer limits |
| Dangerous commands (`FLUSHDB`, `DEBUG`, `KEYS`, `CONFIG SET`, `REPLICAOF`) | none (documented) | `rename-command` / ACL categories |
| Malicious snapshot/AOF file | CRC check for snapshots; protocol validation for AOF | file permissions, signed backups |
| Container privilege | Dockerfile runs as non-root uid 10001 | read-only root fs, seccomp |

Lesson worth stating in interviews: the 2015-2018 wave of compromised Redis servers came from
instances bound to 0.0.0.0 without auth, where attackers used `CONFIG SET dir` + `SAVE` to write
SSH keys. minidis restricts `CONFIG SET` to a few keys partly for that reason.
