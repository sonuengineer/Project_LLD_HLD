# Failure Scenarios -- Webhook Delivery

| # | Scenario | Behaviour | Test |
|---|---|---|---|
| 1 | Customer endpoint returns 5xx | retry with jittered schedule; logged per attempt | `test_transient_failures_then_success` |
| 2 | Endpoint never recovers | dead after max attempts; replay later | `test_wrong_secret_is_rejected_by_receiver_and_retried` |
| 3 | Endpoint slow / hangs | 3s connect / 10s total timeout -> `timeout` outcome, retry | `test_timeout_and_connect_errors_are_logged` |
| 4 | Endpoint says 429/503 + Retry-After | next attempt no earlier than Retry-After | `test_429_retry_after_is_honoured` |
| 5 | Endpoint returns 410 | endpoint disabled, delivery dead, new deliveries wait | `test_410_gone_disables_endpoint` |
| 6 | Endpoint failing for a long time | auto-disabled after N consecutive failures | `test_auto_disable_after_consecutive_failures` |
| 7 | Dispatcher crashes mid-delivery | lease expires, another dispatcher re-claims (attempt+1) | `test_crashed_dispatcher_lease_expires_and_zombie_result_is_rejected` |
| 8 | Zombie dispatcher writes a late result | fenced by `attempts`: rejected as stale | same |
| 9 | Customer got the request but our response was lost | redelivered with same `webhook-id`; receiver dedupes | `test_receiver_dedupes_replayed_delivery` |
| 10 | Publisher retries POST /events | idempotency key -> same event, no extra deliveries | `test_publish_idempotency_key` |
| 11 | API crashes while publishing | transaction rolls back: no event without its deliveries | `test_publish_is_atomic` |
| 12 | URL now resolves to an internal IP (DNS rebinding) | blocked at send time, no request leaves | `test_ssrf_destination_blocked_at_send_time` |
| 13 | Backlog flush to one customer | per-endpoint token bucket; throttled deliveries don't lose attempts | `test_per_endpoint_rate_limit_does_not_burn_attempts` |
| 14 | Redis down | rate limiter fails open (delivery continues); documented | `ratelimit.py` |
| 15 | Postgres down | API returns 500 (publisher retries with idempotency key); dispatchers log and retry the loop with backoff | `test_dispatch_loop_survives_database_errors` |
| 17 | Bug makes delivery processing raise every time | counted as failed attempts -> dead after max attempts (no infinite loop) | `test_crashing_delivery_eventually_goes_dead` |
| 16 | Secret rotation | both secrets sign during grace; old customers keep verifying | `test_secret_rotation_without_failed_deliveries` |

```mermaid
flowchart TD
  S[send] --> R{response}
  R -- 2xx --> OK[succeeded]
  R -- 410 --> G[dead + disable endpoint]
  R -- 429/503 --> RA[next = max(schedule, Retry-After)]
  R -- other / timeout --> F{attempts left?}
  RA --> F
  F -- yes --> P[pending, backoff + jitter]
  F -- no --> D[dead -> replay later]
  P --> C{consecutive failures >= N?}
  C -- yes --> AD[auto-disable endpoint]
```
