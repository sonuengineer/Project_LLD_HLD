from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from pathlib import Path

from .keyspace import EvictionPolicy


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 6380
    dir: Path = Path("./data")
    dbfilename: str = "dump.mdb"
    appendonly: bool = False
    appendfilename: str = "appendonly.aof"
    appendfsync: str = "everysec"
    # "save 60 1000" -> snapshot if >= 1000 changes in 60s. Empty = no automatic snapshots.
    save_rules: list[tuple[int, int]] = field(default_factory=lambda: [(3600, 1), (300, 100), (60, 10000)])
    maxmemory: int = 0
    maxmemory_policy: EvictionPolicy = EvictionPolicy.NOEVICTION
    maxmemory_samples: int = 5
    replicaof: tuple[str, int] | None = None
    replica_output_buffer_limit: int = 64 * 1024 * 1024
    hz: int = 10  # cron frequency (active expiry etc.)
    save_on_shutdown: bool = True

    def get(self, name: str):
        return {
            "maxmemory": self.maxmemory, "maxmemory-policy": self.maxmemory_policy.value,
            "appendfsync": self.appendfsync, "appendonly": "yes" if self.appendonly else "no",
            "save": " ".join(f"{s} {c}" for s, c in self.save_rules), "dir": str(self.dir), "port": self.port,
        }[name]


def parse_args(argv: list[str] | None = None) -> ServerConfig:
    env = os.environ.get
    ap = argparse.ArgumentParser(prog="minidis", description="Redis-like in-memory database (RESP2)")
    ap.add_argument("--host", default=env("MINIDIS_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(env("MINIDIS_PORT", "6380")))
    ap.add_argument("--dir", default=env("MINIDIS_DIR", "./data"))
    ap.add_argument("--appendonly", choices=["yes", "no"], default=env("MINIDIS_APPENDONLY", "no"))
    ap.add_argument("--appendfsync", choices=["always", "everysec", "no"], default=env("MINIDIS_APPENDFSYNC", "everysec"))
    ap.add_argument("--save", default=env("MINIDIS_SAVE", "3600 1 300 100 60 10000"),
                    help='pairs "seconds changes ..."; empty string disables snapshots')
    ap.add_argument("--maxmemory", type=int, default=int(env("MINIDIS_MAXMEMORY", "0")))
    ap.add_argument("--maxmemory-policy", default=env("MINIDIS_MAXMEMORY_POLICY", "noeviction"),
                    choices=[p.value for p in EvictionPolicy])
    ap.add_argument("--replicaof", default=env("MINIDIS_REPLICAOF", ""), help="host:port of the master")
    a = ap.parse_args(argv)
    nums = [int(x) for x in a.save.split()]
    rules = list(zip(nums[0::2], nums[1::2]))
    replicaof = None
    if a.replicaof:
        h, p = a.replicaof.rsplit(":", 1)
        replicaof = (h, int(p))
    return ServerConfig(host=a.host, port=a.port, dir=Path(a.dir), appendonly=a.appendonly == "yes",
                        appendfsync=a.appendfsync, save_rules=rules, maxmemory=a.maxmemory,
                        maxmemory_policy=EvictionPolicy(a.maxmemory_policy), replicaof=replicaof)
