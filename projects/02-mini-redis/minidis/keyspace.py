"""The storage engine: one hash table (dict) of key -> value, plus an expires table.

Value types (Python object -> Redis type):
    bytes                -> string
    collections.deque    -> list   (O(1) push/pop at both ends, like Redis quicklist)
    set                  -> set
    dict                 -> hash

Memory accounting is an ESTIMATE (we add per-entry overhead constants); Python's real
object sizes are not exposed cheaply. It is good enough to drive maxmemory eviction
deterministically and to show the idea of Redis' used_memory.
"""
from __future__ import annotations

import itertools
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Callable

from .protocol import RespError
from .randomset import RandomSet

WRONGTYPE = RespError("WRONGTYPE Operation against a key holding the wrong kind of value")

ENTRY_OVERHEAD = 64      # dict slot + key object + bookkeeping (approximation)
ELEMENT_OVERHEAD = 16    # per element inside a list/set/hash (approximation)


class EvictionPolicy(StrEnum):
    NOEVICTION = "noeviction"
    ALLKEYS_LRU = "allkeys-lru"      # exact LRU via OrderedDict order
    VOLATILE_LRU = "volatile-lru"    # sampled approximate LRU among keys with a TTL (Redis-style)
    VOLATILE_TTL = "volatile-ttl"    # sampled: evict the key closest to expiring


def type_name(value: Any) -> str:
    if isinstance(value, bytes):
        return "string"
    if isinstance(value, deque):
        return "list"
    if isinstance(value, set):
        return "set"
    if isinstance(value, dict):
        return "hash"
    raise TypeError(type(value))


def value_size(value: Any) -> int:
    if isinstance(value, bytes):
        return len(value)
    if isinstance(value, (deque, set)):
        return sum(len(e) + ELEMENT_OVERHEAD for e in value)
    if isinstance(value, dict):
        return sum(len(k) + len(v) + 2 * ELEMENT_OVERHEAD for k, v in value.items())
    raise TypeError(type(value))


@dataclass
class Stats:
    expired_keys: int = 0
    evicted_keys: int = 0
    keyspace_hits: int = 0
    keyspace_misses: int = 0
    active_expire_cycles: int = 0


@dataclass
class Keyspace:
    # OrderedDict order == recency order (oldest first) -> exact LRU for allkeys-lru.
    data: OrderedDict[bytes, Any] = field(default_factory=OrderedDict)
    expires: dict[bytes, int] = field(default_factory=dict)  # key -> absolute unix ms
    sizes: dict[bytes, int] = field(default_factory=dict)
    used_memory: int = 0
    stats: Stats = field(default_factory=Stats)
    # Replicas never delete expired keys themselves; they wait for the master's DEL so
    # master and replica stay identical. They still *hide* expired keys from readers.
    is_replica: bool = False
    clock: Callable[[], int] = field(default=lambda: int(time.time() * 1000))
    # Called with (b"DEL", key) when the master expires/evicts a key -> AOF + replicas.
    on_implicit_delete: Callable[[list[bytes]], None] | None = None

    def __post_init__(self) -> None:
        self._volatile: RandomSet[bytes] = RandomSet()
        self._access_clock = itertools.count()
        self._atime: dict[bytes, int] = {}

    # ---- basic access -------------------------------------------------------------------
    def now_ms(self) -> int:
        return self.clock()

    def _is_expired(self, key: bytes) -> bool:
        when = self.expires.get(key)
        return when is not None and when <= self.now_ms()

    def _expire_if_needed(self, key: bytes) -> bool:
        """Lazy expiration: called on every access. Returns True if the key is (now) gone."""
        if not self._is_expired(key):
            return False
        if self.is_replica:
            return True  # logically expired, physically kept until the master's DEL arrives
        self._remove(key)
        self.stats.expired_keys += 1
        if self.on_implicit_delete:
            self.on_implicit_delete([b"DEL", key])
        return True

    def lookup(self, key: bytes, *, touch: bool = True) -> Any:
        if key not in self.data or self._expire_if_needed(key):
            self.stats.keyspace_misses += 1
            return None
        self.stats.keyspace_hits += 1
        if touch:
            self.data.move_to_end(key)
            self._atime[key] = next(self._access_clock)
        return self.data[key]

    def lookup_typed(self, key: bytes, typ: type, *, create: Callable[[], Any] | None = None) -> Any:
        value = self.lookup(key)
        if value is None:
            if create is None:
                return None
            value = create()
            self.store(key, value, keep_ttl=False)
            return value
        if not isinstance(value, typ):
            raise WRONGTYPE
        return value

    def exists(self, key: bytes) -> bool:
        return key in self.data and not self._expire_if_needed(key)

    def store(self, key: bytes, value: Any, *, keep_ttl: bool = False) -> None:
        if key in self.data:
            self.used_memory -= self.sizes.get(key, 0)
        else:
            self.used_memory += len(key) + ENTRY_OVERHEAD
        self.data[key] = value
        self.data.move_to_end(key)
        self._atime[key] = next(self._access_clock)
        size = value_size(value)
        self.sizes[key] = size
        self.used_memory += size
        if not keep_ttl:
            self.persist(key)

    def adjust_size(self, key: bytes, delta: int) -> None:
        """Collections mutate in place; commands report how many bytes they added/removed."""
        self.sizes[key] = self.sizes.get(key, 0) + delta
        self.used_memory += delta

    def delete(self, key: bytes) -> bool:
        if key not in self.data:
            return False
        expired = self._is_expired(key)
        if expired and not self.is_replica:
            self._expire_if_needed(key)  # master: counts as an expiry, propagates DEL
            return False
        # Replica: a DEL from the master must physically remove the key even if it is already
        # logically expired, otherwise expired keys would leak on replicas forever.
        self._remove(key)
        return not expired

    def _remove(self, key: bytes) -> None:
        self.data.pop(key, None)
        self.used_memory -= self.sizes.pop(key, 0) + len(key) + ENTRY_OVERHEAD
        self._atime.pop(key, None)
        if self.expires.pop(key, None) is not None:
            self._volatile.discard(key)

    def delete_if_empty(self, key: bytes, value: Any) -> None:
        # Redis semantics: an empty list/set/hash does not exist.
        if not value:
            self._remove(key)

    def flush(self) -> None:
        self.data.clear()
        self.expires.clear()
        self.sizes.clear()
        self._atime.clear()
        self._volatile.clear()
        self.used_memory = 0

    # ---- TTL ------------------------------------------------------------------------------
    def set_expire_at(self, key: bytes, when_ms: int) -> None:
        self.expires[key] = when_ms
        self._volatile.add(key)

    def persist(self, key: bytes) -> bool:
        if self.expires.pop(key, None) is not None:
            self._volatile.discard(key)
            return True
        return False

    def pttl(self, key: bytes) -> int:
        if not self.exists(key):
            return -2
        when = self.expires.get(key)
        if when is None:
            return -1
        return max(when - self.now_ms(), 0)

    def active_expire_cycle(self, sample_size: int = 20, max_rounds: int = 16) -> int:
        """Redis' probabilistic active expiry: sample random volatile keys, delete expired ones,
        and repeat while more than 25% of the sample was expired (= lots of garbage left).
        Bounded by max_rounds so one cycle can't block the event loop for long."""
        if self.is_replica:
            return 0
        self.stats.active_expire_cycles += 1
        removed = 0
        for _ in range(max_rounds):
            sample = self._volatile.sample(sample_size)
            if not sample:
                break
            expired = [k for k in set(sample) if self._is_expired(k)]
            for k in expired:
                self._expire_if_needed(k)
            removed += len(expired)
            if len(expired) <= len(sample) // 4:
                break
        return removed

    # ---- eviction -------------------------------------------------------------------------
    def evict_until_fits(self, maxmemory: int, policy: EvictionPolicy, samples: int = 5) -> bool:
        """Free memory before a write. Returns False if we can't get under maxmemory (-> OOM error)."""
        if maxmemory <= 0:
            return True
        while self.used_memory > maxmemory:
            victim = self._pick_victim(policy, samples)
            if victim is None:
                return False
            self._remove(victim)
            self.stats.evicted_keys += 1
            if self.on_implicit_delete:
                self.on_implicit_delete([b"DEL", victim])
        return True

    def _pick_victim(self, policy: EvictionPolicy, samples: int) -> bytes | None:
        if policy is EvictionPolicy.NOEVICTION or not self.data:
            return None
        if policy is EvictionPolicy.ALLKEYS_LRU:
            return next(iter(self.data))  # oldest access is first in the OrderedDict
        candidates = self._volatile.sample(samples)
        if not candidates:
            return None
        if policy is EvictionPolicy.VOLATILE_LRU:
            return min(candidates, key=lambda k: self._atime.get(k, -1))
        return min(candidates, key=lambda k: self.expires.get(k, 2**62))  # VOLATILE_TTL

    # ---- misc -----------------------------------------------------------------------------
    def entry_memory(self, key: bytes) -> int | None:
        if not self.exists(key):
            return None
        return self.sizes.get(key, 0) + len(key) + ENTRY_OVERHEAD

    def __len__(self) -> int:
        return len(self.data)
