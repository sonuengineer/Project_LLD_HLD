# Interview Preparation -- Webhook Delivery

Question bank: `interview/data/p04-webhooks/` (validated), browsable in the portfolio website.

## Stories

1. **Outbox + SKIP LOCKED**: one transaction publishes event + deliveries; Postgres as a queue with leases and fencing.
2. **Signing done right**: Standard Webhooks format (reference vector test), replay protection, dual-signature rotation.
3. **SSRF**: why validation at registration is not enough; DNS rebinding; no redirects.
4. **Retry semantics**: Retry-After, 410, auto-disable, attempt refund on our own rate limit.
5. **Performance debugging with rejected hypotheses**: 48 -> 111 deliveries/s by cutting round trips; proved fsync was NOT the cause.
