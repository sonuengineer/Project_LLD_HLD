from dataclasses import dataclass
from pathlib import Path


@dataclass
class ClusterConfig:
    data_dir: Path
    brokers: int = 3
    segment_bytes: int = 1024 * 1024
    index_interval_bytes: int = 4096
    replica_fetch_wait_ms: int = 50          # follower long-poll wait when nothing new
    replica_lag_max_ms: int = 1000           # follower not caught up for this long -> leaves ISR
    broker_heartbeat_interval_ms: int = 100
    broker_session_timeout_ms: int = 600     # controller declares a silent broker dead
    request_timeout_ms: int = 3000           # acks=all wait limit
    unclean_leader_election: bool = False    # True = availability over durability (may lose data)
    retention_check_interval_ms: int = 5000
    group_rebalance_delay_ms: int = 300      # wait for members to (re)join before finishing a rebalance
    group_min_session_timeout_ms: int = 300
