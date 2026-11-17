class KafkaError(Exception):
    code = "unknown"
    retriable = False


class UnknownTopicOrPartition(KafkaError):
    code = "unknown_topic_or_partition"


class TopicAlreadyExists(KafkaError):
    code = "topic_already_exists"


class NotLeaderForPartition(KafkaError):
    """Client sent to a broker that isn't (or is no longer) leader -> refresh metadata and retry."""
    code, retriable = "not_leader_for_partition", True


class LeaderNotAvailable(KafkaError):
    """Partition offline: no in-sync replica alive (and unclean election disabled)."""
    code, retriable = "leader_not_available", True


class BrokerUnavailable(KafkaError):
    code, retriable = "broker_unavailable", True


class NotEnoughReplicas(KafkaError):
    """acks=all and ISR smaller than min.insync.replicas: refuse BEFORE writing."""
    code, retriable = "not_enough_replicas", True


class RequestTimedOut(KafkaError):
    """acks=all: not replicated in time. The write MAY still become committed later -> retry
    only with an idempotent producer, otherwise you risk a duplicate."""
    code, retriable = "request_timed_out", True


class OutOfOrderSequence(KafkaError):
    code = "out_of_order_sequence_number"


class InvalidReplicationFactor(KafkaError):
    code = "invalid_replication_factor"


class OffsetOutOfRangeError(KafkaError):
    code = "offset_out_of_range"


class UnknownMemberId(KafkaError):
    code = "unknown_member_id"


class IllegalGeneration(KafkaError):
    """A consumer from an OLD generation tried to commit/heartbeat: fenced (zombie consumer)."""
    code = "illegal_generation"


class RebalanceInProgress(KafkaError):
    code, retriable = "rebalance_in_progress", True


class NotEnoughReplicasAfterAppend(KafkaError):
    """acks=all: the record was written, but the ISR shrank below min.insync.replicas while waiting.
    The write is NOT confirmed durable to the promised degree; retry with an idempotent producer."""
    code, retriable = "not_enough_replicas_after_append", True
