# Step 4 -- Server setup (after the instance exists)

Replace `<IP>` with the instance's public IP.

## 4.1 Open ports 80 and 443 -- in TWO places

Oracle blocks traffic at two layers. Both must allow it, or the site will not load even though everything runs.

**Layer 1 -- VCN Security List (Oracle console):**
Networking -> Virtual cloud networks -> your VCN -> Security -> Default Security List -> Add Ingress Rules:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

(Port 22 for SSH is already open by default.)

**Layer 2 -- iptables inside Ubuntu:** handled by `scripts/bootstrap-ubuntu.sh` (Oracle's Ubuntu image ships
with a REJECT-all rule except SSH).

## 4.2 First login

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<IP>
```

Optional, in `C:\Users\Admin\.ssh\config`:

```
Host oracle
    HostName <IP>
    User ubuntu
    IdentityFile ~/.ssh/oracle_portfolio
```

Then just `ssh oracle`.

## 4.3 One-time setup

From this PC:

```bash
scp -i ~/.ssh/oracle_portfolio deployment/scripts/bootstrap-ubuntu.sh ubuntu@<IP>:~
ssh -i ~/.ssh/oracle_portfolio ubuntu@<IP> 'sudo bash ~/bootstrap-ubuntu.sh'
```

The script (read it first, it is short):
1. Opens 80/443 in iptables and saves the rules (BEFORE Docker is installed, so Docker's own chains are not saved).
2. Installs Docker Engine + compose plugin from Docker's official apt repo and adds `ubuntu` to the `docker` group.
3. Installs Caddy from its official apt repo.
4. Adds a 4 GB swap file (protects small shapes from out-of-memory kills during builds).
5. Enables automatic security updates.

Log out and back in once so the `docker` group applies.

## 4.4 App layout on the server

```
/srv/apps/
  nest-app/        git clone of the NestJS project + docker-compose.yml + .env
  fastapi-app/     git clone of the FastAPI project + docker-compose.yml + .env
  backend-demos/   git clone of Project_LLD_HLD (only selected demos are started)
/etc/caddy/Caddyfile
```

Rules that keep it safe:
- Each app publishes ONLY on `127.0.0.1:<port>` (e.g. `"127.0.0.1:3000:3000"`). Caddy is the only thing on 80/443.
- Databases have NO `ports:` at all -- the app reaches them by service name on the compose network.
- Real secrets live in `/srv/apps/<app>/.env` on the server (chmod 600), never in git.
- Images must exist for ARM64: official `node`, `python`, `postgres`, `mongo`, `mysql`, `redis` images all do.

Example compose for one app (pattern -- adapt names/ports to the real project):

```yaml
services:
  api:
    build: .
    env_file: .env
    ports: ["127.0.0.1:3000:3000"]
    depends_on: [db]
    restart: unless-stopped
  db:
    image: postgres:16
    env_file: .env            # POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
    volumes: [dbdata:/var/lib/postgresql/data]
    restart: unless-stopped
volumes:
  dbdata:
```

## 4.5 Caddy (HTTPS + routing)

Copy `scripts/Caddyfile.example` to `/etc/caddy/Caddyfile`, set your hostnames, then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

HTTPS certificates are automatic, but only for a real hostname that points at `<IP>` (A record).
No domain? A free DuckDNS name (`yourname.duckdns.org`) works. A bare IP only gets plain HTTP.

## 4.6 Backups (databases live only in Docker volumes)

Minimum: a nightly dump with cron, e.g. for Postgres:

```bash
# crontab -e   (as ubuntu)
0 2 * * * docker compose -f /srv/apps/nest-app/docker-compose.yml exec -T db pg_dump -U <user> <db> | gzip > /srv/backups/nest-$(date +\%F).sql.gz
```

Copy the backups off the server now and then (e.g. `scp` to this PC). If the instance is lost, the volumes go with it.

## 4.7 Live demos from this repo -- before exposing any

From the earlier review: P10 (workflow engine) API has no auth; P08 / P09 demos allow passwordless signup; several
admin tokens default to `change-me-...`. Before exposing a demo: set real tokens in its `.env`, and put it behind
Caddy `basic_auth` (see the commented block in `Caddyfile.example`).
