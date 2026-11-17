# Trade-offs -- Distributed Rate Limiter

1. **Centralized Redis vs local counters.** Redis gives one global truth (correct limits across
   instances) at the cost of a network hop per check and a dependency that can fail. Local counters
   are free but each instance allows the full limit (proven 3x overshoot in tests).

2. **Lua script vs INCR-first vs WATCH/MULTI.** INCR-first is atomic but only fits fixed window and
   counts rejected requests. WATCH needs retry loops under contention. Lua handles every algorithm
   atomically in one round-trip; downside: scripts block Redis while running, so they must stay O(1)
   or O(log n) (sliding log cleanup is the heaviest one).

3. **Redis TIME vs app clock.** Redis time removes cross-server clock skew. Cost: scripts calling TIME
   are non-deterministic, which mattered for old script replication (Redis < 5 needed
   `redis.replicate_commands()`); Redis 7 uses effects replication, so it is fine.

4. **Sequential multi-policy checks.** Simple and lets us stop at the first denial, but not atomic
   across policies: a request allowed by `ip_global` and denied by `user_plan` already consumed one
   `ip_global` unit. Alternative: one script over all keys (atomic, but couples policies and needs all
   keys in one cluster slot). Mitigation: broad/cheap policies first.

5. **Not counting rejected requests.** Clients that back off aren't punished. Some APIs deliberately
   count rejections to penalize hammering; that would be a one-line change in the script.

6. **Fail-open default, fail-closed for login.** Availability for normal APIs; security for brute
   force targets. Fail-open means a Redis outage removes protection; alerting on
   `rate_limit_backend_errors_total` is mandatory.

7. **Policy cache TTL (5s) and API key cache TTL (30s).** Fewer Redis calls and resilience to blips,
   paid for with eventual consistency (config changes and key revocations are not instant).

8. **Sliding counter approximation.** O(1) memory for huge key spaces (per-IP), but it assumes
   traffic in the previous window was evenly spread. Sliding log is exact but O(limit) memory.

9. **Short Redis timeouts.** 250ms caps added latency but under event-loop saturation a timeout
   can fire because *our* process was busy, producing false "Redis down" decisions. 50ms caused
   exactly that during load testing (see TESTING.md).
