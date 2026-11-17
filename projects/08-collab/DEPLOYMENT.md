# Deployment -- Collaborative Editing

```bash
docker compose up -d --build     # postgres, redis, migrate, collab1, collab2, nginx (127.0.0.1:58008)
open http://127.0.0.1:58008/editor
python demo.py http://127.0.0.1:58008
```

- Load balancer: WebSocket upgrade headers + long `proxy_read_timeout` (idle sockets). Sticky sessions NOT required.
- Each server needs a unique `COLLAB_SERVER_ID` (logs, presence).
- Graceful deploys: clients reconnect automatically (demo page retries every 1s) and catch up from `last_rev`.
- Monitor `/stats`: `gap_fills` (Redis delivery problems), `slow_disconnects`, rooms per server.
- Postgres is the source of truth; Redis can be restarted (forwarders gap-fill from Postgres).
