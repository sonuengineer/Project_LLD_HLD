# Deployment -- Webhook Delivery

Roles from one image: `api` (uvicorn), `dispatcher` (`python -m webhooks.dispatcher`, scale horizontally),
`migrate` (one-shot `alembic upgrade head`), and the optional demo `receiver`.

```bash
docker compose up -d --build
docker compose up -d --scale dispatcher=4
```

## Production checklist

1. `WH_ALLOW_PRIVATE_DESTINATIONS=false` (default). The compose demo sets true only to reach the
   receiver container.
2. Egress through a NAT gateway with static IPs (customers allow-list them); block egress to
   internal CIDRs at the network layer too (defence in depth for SSRF).
3. Encrypt endpoint secrets at rest (KMS); restrict who can call `/secret`.
4. Retention job: delete/partition `delivery_attempts` and old `events` (e.g. 30-90 days).
5. Alerts: oldest pending delivery age (`/stats`), dead count growth, endpoints auto-disabled,
   dispatcher error logs (`deliver_crashed`), stale results (`stale_delivery_result`).
6. Postgres connection budget: each dispatcher uses up to pool 10 + overflow 10.
