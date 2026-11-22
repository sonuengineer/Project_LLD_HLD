# Deployment guide

Every step taken to put this project online, in order, written so it can be repeated without the chat history.
Screenshots are in `screenshots/` (kept out of git because they show the Oracle account name).

## Current status (2026-11-21)

| Step | What | Status |
|---|---|---|
| 1 | Push code to GitHub | DONE -- https://github.com/sonuengineer/Project_LLD_HLD (branch `main`) |
| 2 | Portfolio site on Vercel | DONE -- https://portfolio-beta-two-51.vercel.app |
| 3 | Create Oracle A1 server | DONE (2026-11-19) -- `portfolio-a1`, 2 OCPU / 12 GB, Ubuntu 24.04 ARM64; landed on attempt 258 of the loop running on the micro server (after many failed attempts from the PC earlier) (`05-oci-cli-auto-retry.md`, `06-oracle-micro-server.md`) |
| 3a | Second Oracle A1 server | DONE (2026-11-20) -- `portfolio-a2`, 2 OCPU / 12 GB, 50 GB disk, Ubuntu 24.04 ARM64, bootstrap applied and verified; got it with the same retry loop (`--name portfolio-a2 --boot-gb 50`) -- `06-oracle-micro-server.md` section 6.7 |
| 3b | Oracle micro server (1 GB, AMD) | DONE (2026-11-18) -- `portfolio-micro`, bootstrap applied and verified -- `06-oracle-micro-server.md` |
| 4 | Server setup (firewall, Docker, Caddy) | DONE on the micro, the A1 and the A2 (Docker, Caddy, swap, iptables verified, port 80 answers 200) -- `scripts/bootstrap-ubuntu.sh` |
| 5 | Deploy NestJS + FastAPI projects + selected demos | Planned -- layout in `04-oracle-server-setup.md` |
| 6 | H11 reverse proxy on `portfolio-a2` (loopback only, measured, hardened systemd service installed but stopped) | DONE 2026-11-20 -- `07-reverse-proxy-on-a2.md` 7.1-7.8; no public exposure |
| 6a | H11 two-host measurement (proxy on A2, test upstreams on A1, private network) | DONE 2026-11-21 -- `07-reverse-proxy-on-a2.md` 7.9; temporary network and firewall rules were removed again and A1 verified against a snapshot |
| 6b | H12 message broker as a 3-server cluster (A2 + micro + A1, private network), experiments B1-B7 | DONE 2026-11-21 -- `08-message-broker-cluster.md`; everything temporary, removed again, all three servers verified against snapshots |

## Server change log (dated)

Every change made to the servers and cloud accounts, oldest first. Dates are UTC unless marked; the source of each date is
given so it can be checked.

| Date | Where | Change | Source |
|---|---|---|---|
| 2026-11-17 | PC | SSH key `oracle_portfolio` and the Oracle API key created | file timestamps |
| 2026-11-17 | Oracle network | VCN `portfolio-vcn`, internet gateway, route table, subnet `portfolio-public`; security list ingress TCP 22, 80, 443 + ICMP | `05-oci-cli-auto-retry.md` |
| 2026-11-18 | portfolio-micro | hand-made micro deleted, `portfolio-micro` re-created with our SSH key; bootstrap applied (Docker, Caddy, 4 GB swap, iptables 80/443) | `06-oracle-micro-server.md` 6.1-6.4 |
| 2026-11-18 | portfolio-micro | A1 retry loop moved onto the micro as systemd service `oci-a1-retry` (API key copied there temporarily) | `06-oracle-micro-server.md` 6.5b |
| 2026-11-19 | portfolio-a1 | launched (attempt 258 of the retry loop); bootstrap applied | status table above |
| 2026-11-19 | Azure | free Azure SQL database created; firewall rule allows only the A1's public IP | local notes file timestamp |
| about 2026-11-19 | portfolio-a1 | NeoCBS deployed (containers web, api, clamav, seaweedfs; Caddy with a DuckDNS site) by a SEPARATE session; not documented in this repo | container uptime on 2026-11-21 |
| 2026-11-20 (IST) | portfolio-a2 | launched with `--name portfolio-a2 --boot-gb 50`; bootstrap applied; retry service on the micro disabled; API key deleted from the micro | `06-oracle-micro-server.md` 6.7 |
| 2026-11-20 | portfolio-a2 | Node.js v20.20.1 in `/opt/node`; H11 code in `~/h11`; tests and experiments run | `07-reverse-proxy-on-a2.md` 7.2-7.5 |
| 2026-11-20 | portfolio-a2 | systemd units `reverse-proxy` and `demo-upstream` and user `reverse-proxy` installed; tried, then stopped and disabled | `07-reverse-proxy-on-a2.md` 7.6 |
| 2026-11-20 | Vercel | portfolio site redeployed with H11 (live at 11:57 UTC) | deploy check |
| 2026-11-21 11:57-12:04 | Oracle network + portfolio-a1 | TEMPORARY: one security-list rule and one A1 firewall rule (A2 only, test ports), two test processes and Node in A1's home folder; all removed and verified | `07-reverse-proxy-on-a2.md` 7.9 |
| 2026-11-21 16:58-17:25 | Oracle network + portfolio-a2, -micro, -a1 | TEMPORARY (H12): three security-list rules `h12-bench-*` (TCP 19001-19002, each from one private address), two iptables rules per server (comment `h12-bench`, not saved), `~/h12` with code and Node on micro and A1, brokers as `nice -n 19` processes, bench + nats-server in `~/h12` on A2. All removed; servers compared with before-snapshots; one orphaned loopback nats-server on A2 found and stopped | `08-message-broker-cluster.md` 8.9-8.10 |
| 2026-11-21 17:41-17:43 | portfolio-a2 | TEMPORARY (H14): `git archive` of `projects/14-auth-server` into `~/h14`, `npm ci`, full test suite on Linux (177/177) and mutation M29 (keys.json mode) once; `~/h14` deleted, A2 compared with a before-snapshot: no difference. No ports, no rules | `projects/14-auth-server/README.md` (M29) |
| 2026-11-21 17:47-18:24 | portfolio-a2 | TEMPORARY (A1 minibox): `~/h16` with the code and pytest (not installed system-wide), alpine:3.20 pulled from Docker Hub, containers run as root with cgroups under `/sys/fs/cgroup/minibox`, limits measured, 29 mutation checks. INCIDENT 18:15: one mutation let the fork-bomb test run outside its cgroup; 1-minute load average about 3172 until systemd's session task limit stopped it; services stayed up. Afterwards: `~/h16`, cgroups, mounts and processes gone, after-snapshot identical; re-checked independently at 18:40 (load 0.10, caddy/docker/ssh active, no failed units, no leftovers) | `projects/16-container-runtime/SERVER_RUN.md` |
| 2026-11-22 13:35-13:47 | portfolio-a2 | TEMPORARY (A1 minibox stage 4a, `--net veth`): `~/h16` with code and pytest (not installed), alpine:3.20 pulled; containers with veth pairs `mbx*` on `10.200.0.0/16` /30s, no iptables rule, no default route in the container; 11 network mutations + M13 re-check. One run of mine forgot to deselect the fork bomb test; it did not start (that mutation failed every container at setup); load checked at once, 0.63. Afterwards `~/h16` and `/run/minibox-net.lock` deleted; extended after-snapshot (links, addresses, routes, filter + nat rules, ip_forward) identical | `projects/16-container-runtime/SERVER_RUN.md` section 6 |

## What is on each server now (2026-11-21, checked again after the H12 run at 17:25 UTC: unchanged)

| Server | Installed / running | Notes |
|---|---|---|
| `portfolio-micro` (AMD, 1 OCPU / 1 GB) | Docker, Caddy, 4 GB swap; service `oci-a1-retry` disabled | no API key on it any more; free to use |
| `portfolio-a1` (ARM, 2 OCPU / 12 GB) | Docker, Caddy (serves the NeoCBS DuckDNS site on 443), NeoCBS containers | managed outside this repo; nothing from H11 is left on it |
| `portfolio-a2` (ARM, 2 OCPU / 12 GB, 50 GB disk) | Docker, Caddy default page on port 80, Node.js in `/opt/node`, `~/h11` (code, bench, results), `reverse-proxy` + `demo-upstream` units (stopped, disabled) | remove the service with the line printed by `deploy/install-on-ubuntu.sh` |
| Oracle network | security list: TCP 22, 80, 443 and ICMP from anywhere | the temporary H11 rule was removed on 2026-11-21 |
| Azure | free SQL database, firewall allows the A1 only | check "free amount remaining" in the portal |
| Your PC | `~/.oci` (API key, still ACTIVE in Oracle), `~/.ssh/oracle_portfolio`, `~/.oci/seclist-backups/` | revoke the API key in the Oracle console when the SDK is no longer needed |

## Files

| File | Read it for |
|---|---|
| [01-github.md](01-github.md) | How the repo was pushed, the two-GitHub-accounts problem and the fix |
| [02-vercel-portfolio.md](02-vercel-portfolio.md) | Deploying the portfolio site on Vercel, and how redeploys work |
| [03-oracle-create-instance.md](03-oracle-create-instance.md) | Creating the A1 server click by click, the capacity error, and the ways around it |
| [05-oci-cli-auto-retry.md](05-oci-cli-auto-retry.md) | OCI CLI/SDK install, API key, network creation, auto-retry loop -- every command |
| [06-oracle-micro-server.md](06-oracle-micro-server.md) | The small free AMD micro server: why, how it was created, SSH key lesson, verify, limits |
| [07-reverse-proxy-on-a2.md](07-reverse-proxy-on-a2.md) | Running and measuring the H11 reverse proxy on the second A1 server: Node install, tests, service, experiments |
| [08-message-broker-cluster.md](08-message-broker-cluster.md) | The H12 broker as a temporary 3-server cluster (A2 + micro + A1): rules, brokers, experiments B1-B7, cleanup and proof, dated timeline |
| [04-oracle-server-setup.md](04-oracle-server-setup.md) | After the server exists: public IP, SSH, firewall, Docker, Caddy, app layout |
| [scripts/bootstrap-ubuntu.sh](scripts/bootstrap-ubuntu.sh) | One-time server setup script (run on the server) |
| [scripts/Caddyfile.example](scripts/Caddyfile.example) | Reverse proxy + automatic HTTPS for several apps on one server |
| [scripts/oci_a1_grab.py](scripts/oci_a1_grab.py) | Python SDK: create network + retry the A1 launch (the one actually used) |
| [scripts/oci_seclist_rule.py](scripts/oci_seclist_rule.py) | Python SDK: add/remove ONE tagged security-list rule safely (dry run, backup, verification) |
| [scripts/oci_micro_create.py](scripts/oci_micro_create.py) | Python SDK: create the free AMD micro server with our SSH key (optionally replace a hand-made one) |
| [scripts/oci-create-network.sh](scripts/oci-create-network.sh) | CLI version of the network setup |
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
