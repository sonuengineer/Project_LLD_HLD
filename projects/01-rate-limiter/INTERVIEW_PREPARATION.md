# Interview Preparation -- Distributed Rate Limiter

The full question bank (100+ questions, Hinglish answers, linked to this code) lives in
`interview/data/p01-rate-limiter/` and is browsable in the portfolio website's Interview section.
It is validated by `python interview/validate.py --only p01-rate-limiter` (checks every referenced
file and symbol exists).

## The 5 stories to be able to tell without notes

1. **Why in-memory fails, proven by a test** -- `tests/test_distributed_correctness.py`: 3 in-memory
   "servers" allow exactly 3x the limit.
2. **Race condition on shared Redis** -- naive GET/SET overshoots; the Lua script is exact for 200
   concurrent requests across 3 clients for all 5 algorithms.
3. **Algorithm choice per use case** -- sliding log for login (exact, small), sliding counter for
   per-IP (O(1) memory), token bucket for bursty search, leaky bucket for a slow downstream.
4. **Failure policy** -- fail-open by default, fail-closed for login, auth always fails closed (503).
5. **Load testing found two real bugs** -- connection pool exhaustion silently failing open, and
   blocking log writes causing false Redis timeouts (see TESTING.md).

## Pitch

See `interview/data/p01-rate-limiter/meta.json` (`pitch.intro_30s`, `explain_2min`, `deep_5min`, ...).
