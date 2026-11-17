# System Design -- Webhook Delivery

## Polling vs webhooks

Polling: the customer asks "anything new?" every N seconds -- wasted requests and up to N seconds of
latency. Webhooks: we push when something happens -- near real time, but now WE own reliability
(retries, signing, ordering, endpoint failures). This system is that ownership.

## Guarantees

| Property | Guarantee here |
|---|---|
| Delivery | at-least-once (lease + retries); duplicates possible -> `webhook-id` for dedupe |
| Ordering | none across events (retries reorder) -- documented; include `created_at`, consumers fetch latest state |
| Authenticity | HMAC over id + timestamp + body |
| Freshness | receiver rejects timestamps older than 5 minutes |
| Durability | event + deliveries committed in one transaction before the API returns 201 |

## Retry policy

Default schedule after attempt n: 5s, 30s, 2m, 10m, 30m, 1h, 3h, 6h (+-20% jitter) = 9 attempts
over ~11 hours, then `dead`. `429`/`503` with `Retry-After` push the next attempt further out.
`410 Gone` = the customer told us to stop -> endpoint disabled.

## Capacity

Per delivery: 1/batch claim statement + 1 record statement + 1 Redis call + the HTTP request.
Measured (TESTING.md): 111 deliveries/s with 1 dispatcher, 189/s with 3 on a shared dev machine;
the single-process benchmark is CPU-bound in Python, so scale dispatchers horizontally.

## Scaling path

| Scale | Change |
|---|---|
| 10x | more dispatcher replicas; GIN index on `endpoints.event_types`; partition `delivery_attempts` by month |
| 100x | partition `deliveries` by status/time or move the hot queue to Kafka/SQS while keeping Postgres as the outbox (relay pattern); per-endpoint queues so one slow customer can't fill dispatcher slots (bulkheads); HTTP/2 connection pooling per host |
| Slow customers | per-endpoint concurrency caps + circuit breaker (open after failures, half-open probe) |
