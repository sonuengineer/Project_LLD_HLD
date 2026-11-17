"""Retry delay: exponential backoff with FULL jitter.

    delay = random(0, min(max, base * 2^(attempt-1)))

Why jitter: if 1000 jobs fail at the same moment because a dependency went down, plain
exponential backoff retries all 1000 at exactly the same instants (thundering herd) and
knocks the dependency over again. Full jitter spreads them across the whole window.
(AWS Architecture Blog, "Exponential Backoff and Jitter", 2015.)
"""
from __future__ import annotations

import random


def retry_delay_ms(attempt: int, base_ms: int, max_ms: int, rng: random.Random | None = None) -> int:
    cap = min(max_ms, base_ms * (2 ** max(attempt - 1, 0)))
    return int((rng or random).uniform(0, cap))
