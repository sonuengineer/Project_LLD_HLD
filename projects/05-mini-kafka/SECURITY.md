# Security -- minikafka

| Area | State | Production equivalent |
|---|---|---|
| Client authentication | none on produce/consume (documented) | SASL (SCRAM / OAUTHBEARER) or mTLS |
| Authorization | none; only fault-injection endpoints need `X-Admin-Token` (constant-time compare) | ACLs per topic / group / operation |
| Encryption in transit | none (HTTP) | TLS listeners |
| Encryption at rest | none | disk encryption; payload-level encryption for sensitive fields |
| Input validation | topic name pattern, partition/rf bounds, batch size <= 10k records, max_bytes <= 16MB, offsets >= 0 | quotas per client id |
| Integrity | CRC32 per record (detects corruption, not tampering) | TLS + signed payloads if needed |
| Resource abuse | none beyond validation | produce/fetch byte-rate quotas per client |
| Container | non-root user, data volume | read-only rootfs, network policies |

Interview points: Kafka ACLs are per principal + resource + operation (e.g. `User:billing` may READ
topic `orders` and group `billing`); without quotas one noisy producer can saturate brokers for all.
