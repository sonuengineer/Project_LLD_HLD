"""A set with O(1) add, remove and uniform random choice.

Python dicts/sets can't pick a random element without O(n) work. Active expiry and
sampled eviction need random keys constantly, so we keep keys in a list plus a
key -> index map. Removal swaps the victim with the last element (no shifting).
Same idea Redis gets from sampling random hash-table buckets.
"""
from __future__ import annotations

import random
from typing import Generic, Hashable, TypeVar

T = TypeVar("T", bound=Hashable)


class RandomSet(Generic[T]):
    __slots__ = ("_items", "_index")

    def __init__(self) -> None:
        self._items: list[T] = []
        self._index: dict[T, int] = {}

    def add(self, item: T) -> None:
        if item not in self._index:
            self._index[item] = len(self._items)
            self._items.append(item)

    def discard(self, item: T) -> None:
        idx = self._index.pop(item, None)
        if idx is None:
            return
        last = self._items.pop()
        if idx < len(self._items):
            self._items[idx] = last
            self._index[last] = idx

    def sample(self, k: int) -> list[T]:
        n = len(self._items)
        if n == 0:
            return []
        if n <= k:
            return list(self._items)
        return [self._items[random.randrange(n)] for _ in range(k)]  # with replacement, like Redis

    def clear(self) -> None:
        self._items.clear()
        self._index.clear()

    def __len__(self) -> int:
        return len(self._items)

    def __contains__(self, item: object) -> bool:
        return item in self._index
