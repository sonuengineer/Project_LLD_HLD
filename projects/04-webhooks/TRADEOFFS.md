# Trade-offs -- Webhook Delivery

1. **Postgres queue vs Redis/Kafka.** One transaction for event + deliveries (no dual write, easy
   audit/SQL queries). Costs DB load per delivery and vacuum churn; fine to thousands/s, beyond that
   relay the outbox into a log (Kafka) and keep Postgres as the source of truth.
2. **At-least-once vs exactly-once.** Exactly-once over HTTP to a third party is impossible (a 2xx can
   be lost after the customer processed it). We give stable ids so receivers dedupe.
3. **No ordering.** Ordered delivery requires per-endpoint serialization: one stuck event blocks all
   later ones (head-of-line blocking). Most providers choose unordered + "fetch latest state".
4. **Attempt refund on rate limiting.** Being throttled by our own budget isn't the endpoint's fault;
   costs a slightly more complex claim/unclaim.
5. **Auto-disable.** Protects dispatcher capacity from dead endpoints; a customer's long outage means
   they must re-enable and replay.
6. **Jittered fixed schedule.** Predictable for customers ("we retry for ~11 hours") vs pure exponential.
7. **Dual-signature rotation.** Zero failed deliveries during rotation; signatures header grows.
8. **Endpoint health on success only when it changes.** Removes a hot-row write per delivery; the
   failure counter is still exact because every failure writes.
9. **Plaintext signing secret in DB.** Needed to compute HMACs; mitigate with encryption at rest/KMS.
