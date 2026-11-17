# Deployment -- Payment System

```bash
docker compose up -d --build     # postgres (volume), migrate, mock provider, api (127.0.0.1:58009), recovery worker
python demo.py http://127.0.0.1:58009
```

**Never put real provider credentials in this project.** It is wired to the mock provider by design.

Checklist for a real deployment (what would change):
1. Real provider adapter behind `PaymentProvider`; keys from a secret manager; webhook secret per endpoint.
2. Recovery worker always running; alert on payments in `requires_reconciliation` older than N minutes.
3. Daily reconciliation job per provider and currency; human review queue for exceptions.
4. Idempotency key retention (e.g. 7 days) with a cleanup job; partition events/ledger tables by month.
5. Postgres with PITR backups; the ledger is the system of record.
6. Rate limiting per merchant (Project 1) and RBAC for admin operations (Project 6).
