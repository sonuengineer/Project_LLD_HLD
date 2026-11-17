# Deployment guide

Every step taken to put this project online, in order, written so it can be repeated without the chat history.
Screenshots are in `screenshots/` (kept out of git because they show the Oracle account name).

## Current status (2026-11-17)

| Step | What | Status |
|---|---|---|
| 1 | Push code to GitHub | DONE -- https://github.com/sonuengineer/Project_LLD_HLD (branch `main`) |
| 2 | Portfolio site on Vercel | DONE -- https://portfolio-beta-two-51.vercel.app |
| 3 | Create Oracle A1 server | BLOCKED -- Mumbai "Out of capacity" for A1 at 4, 2 and 1 OCPU. Nothing was created. |
| 4 | Server setup (firewall, Docker, Caddy) | Ready to run once step 3 succeeds -- `scripts/bootstrap-ubuntu.sh` |
| 5 | Deploy NestJS + FastAPI projects + selected demos | Planned -- layout in `04-oracle-server-setup.md` |

## Files

| File | Read it for |
|---|---|
| [01-github.md](01-github.md) | How the repo was pushed, the two-GitHub-accounts problem and the fix |
| [02-vercel-portfolio.md](02-vercel-portfolio.md) | Deploying the portfolio site on Vercel, and how redeploys work |
| [03-oracle-create-instance.md](03-oracle-create-instance.md) | Creating the A1 server click by click, the capacity error, and the ways around it |
| [04-oracle-server-setup.md](04-oracle-server-setup.md) | After the server exists: public IP, SSH, firewall, Docker, Caddy, app layout |
| [scripts/bootstrap-ubuntu.sh](scripts/bootstrap-ubuntu.sh) | One-time server setup script (run on the server) |
| [scripts/Caddyfile.example](scripts/Caddyfile.example) | Reverse proxy + automatic HTTPS for several apps on one server |
| [scripts/oci-retry-launch.sh](scripts/oci-retry-launch.sh) | Optional: keep retrying the A1 launch until Oracle has capacity |

## Architecture decision (why it is split this way)

```
                 +---------------------------+
 visitors  --->  | Vercel (free)             |   portfolio + interview site (static files)
                 | portfolio-beta-two-51...  |   auto-redeploys on every git push
                 +---------------------------+

                 +---------------------------+
 visitors  --->  | Oracle A1 (Always Free)   |   Caddy :80/:443  (HTTPS, routes by subdomain)
                 |  Ubuntu 24.04, ARM64      |     -> NestJS app      (127.0.0.1:3000)
                 |                           |     -> FastAPI app     (127.0.0.1:8000)
                 |                           |     -> selected demos  (127.0.0.1:58xxx)
                 |                           |   databases: Docker internal network only
                 +---------------------------+
```

- Static site on Vercel: global CDN, zero maintenance, no server to patch.
- Long-running backends (WebSockets, workers, databases) need a real server -> Oracle A1.
- Render free tier was rejected: services sleep after ~15 min idle (30-60 s cold start) and the free Postgres expires.

## Keys and secrets

- SSH key for the server: `C:\Users\Admin\.ssh\oracle_portfolio` (private, never share) and `oracle_portfolio.pub` (public, uploaded to Oracle).
- No secrets are in this repo. Each app's real `.env` lives only on the server.
