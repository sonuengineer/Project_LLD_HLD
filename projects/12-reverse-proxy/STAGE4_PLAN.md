# Stage 4 plan -- run it on a real server and MEASURE it

Status (2026-11-21): steps 4a-4g are DONE in single-host (loopback) mode (2026-11-20), and the two-host mode was done on
2026-11-21 (experiments X1-X4, temporary rules removed afterwards). 4h (public URL) was NOT done. Results: `README.md` section "Measured on a real server" and `bench/reference-results/`. Server steps:
`deployment/07-reverse-proxy-on-a2.md`. The text below is the ORIGINAL plan, kept as written; where reality differed:

- E4 needed a second, raw upstream (no Keep-Alive hint) before the stale-connection race showed up.
- E9 found a real shutdown defect; it was fixed and re-measured (4540 ms -> 1611 ms).
- E6 only covers a closed port on the same host; `EHOSTUNREACH` across hosts was measured later, in the two-host run (X4).
- The proxy's default settings were reviewed against the data and left unchanged.
- Every number in the README comes from a saved raw result file.

## What stage 4 must deliver

1. The proxy running on `portfolio-a2` as a hardened systemd service.
2. Measured answers to questions the code only reasons about today (see the experiment table).
3. Defaults (ejectAfter, ejectMs, probe interval, timeouts, retries) kept or changed BASED ON DATA.
4. The interview bank at 100+ questions, the new ones written from real findings.
5. A step-by-step deployment doc with every command (placeholders for IPs, safe for the public repo).

## Facts found on 2026-11-20 (read-only look at both servers)

| | portfolio-a1 | portfolio-a2 |
|---|---|---|
| Role today | NeoCBS is running (4 containers, Caddy on 80/443) -- do NOT touch | idle, Caddy default page on port 80 |
| Chip / OS | aarch64, Ubuntu 24.04 | aarch64, Ubuntu 24.04 |
| Memory | 11.9 GB total, about 9.8 GB available (mostly cache) | 11.9 GB total, about 11.3 GB available |
| Node.js | not installed | not installed |
| Firewall (iptables INPUT) | accepts only 22, 80, 443, then REJECT with icmp-host-prohibited | same |

Consequence of the REJECT rule: a closed port reached from ANOTHER host gives the client `EHOSTUNREACH` (no route to
host), not `ECONNREFUSED`. Our retry list includes `EHOSTUNREACH`, but it has never been exercised against a real one.

## Topology: two modes

| Mode | Where things run | Needs | Recommendation |
|---|---|---|---|
| 1. Single host | proxy, test upstreams and load generator all on A2 over loopback | nothing outside A2; A1 and NeoCBS untouched | START HERE |
| 2. Two hosts | proxy + generator on A2, test upstreams on A1 over the private network | an ingress rule in the shared Oracle security list, plus an iptables rule on A1 (sources limited to A2's private IP) | only if mode 1 leaves a question open; needs your explicit OK |

Mode 1 caveat: proxy, upstreams and generator share 2 cores, so absolute numbers are NOT production capacity. They are
valid for comparisons run the same way (direct vs proxy, round-robin vs least-connections) and for behaviour
(failover, retries, timeouts). This is stated next to every number.

Mode 1 can still produce a REAL network black hole for the connect-timeout test: `iptables -I OUTPUT -p tcp -d 127.0.0.1
--dport <port> -j DROP` makes connects hang. Every such rule is removed by a trap, plus a watchdog that deletes it after
120 s, so a mistake cannot lock anyone out (reboot also clears it: rules are not saved).

## Steps

| # | Step | Touches servers? | Needs your OK |
|---|---|---|---|
| 4a | Local prep (below) | no | no |
| 4b | Install Node (official arm64 tarball, checksum verified) on A2 and deploy the built `dist/` | A2 only | yes |
| 4c | systemd service, localhost only, no public exposure | A2 only | yes (same OK as 4b) |
| 4d | Run the experiments, save raw results | A2 only | yes (same OK) |
| 4e | Decide defaults from the data; README "Measured" section with conditions and caveats | no | no |
| 4f | Interview bank 75 -> 100+ from real findings; regenerate portfolio data | no | no |
| 4g | `deployment/07-reverse-proxy-on-a2.md` with every command | no | no |
| 4h | Optional: public URL via Caddy + a DuckDNS name YOU create; redeploy the portfolio on Vercel | A2 + public | yes, separately |

### 4a Local prep (small code changes first, each with a test)

- Graceful-shutdown test (spawn `dist/index.js`, send SIGTERM during a slow request, expect it to finish and exit 0).
- Add the failure REASON to the request log (`error: "ECONNREFUSED"` and so on): today a 502 does not say why.
- Optional `STATS_INTERVAL_MS`: one JSON line per interval with per-upstream active count, healthy flag, ejected flag.
  Needed to prove the counters return to zero during a long soak.
- `bench/` folder with its OWN `package.json` (pinned `autocannon@9.0.0`), so the proxy keeps zero runtime dependencies:
  a test upstream (`/health` that can be toggled, `/work?ms=`, `/big?mb=`, configurable keep-alive timeout) and a runner
  that writes raw JSON per run plus a summary table generated from those files (nothing typed by hand).

### 4b-4c Service on A2 (all additive, nothing existing is changed)

- `/opt/node` from the official tarball (verify the SHA-256 from the published SHASUMS file) and `/opt/reverse-proxy` with
  only `dist/` (the proxy has no runtime dependencies).
- A system user without login, `reverse-proxy.service` with `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`,
  `MemoryMax`, `Restart=on-failure`, and an `EnvironmentFile` (no secrets are needed).
- Listens on 127.0.0.1 only. No Caddy change, no new open port, no security-list change.
- Rollback: `systemctl disable --now reverse-proxy` and delete the two folders and the user.

## Experiments (raw outputs saved, each run 3 times, report median and spread, never only the best)

| # | Question | Method | Replaces which claim |
|---|---|---|---|
| E1 | What does the proxy cost? | autocannon direct to an upstream vs through the proxy with 1 upstream, same connections and duration | "negligible" (never measured) |
| E2 | Does least-connections beat round-robin when one upstream is slow? | 2 upstreams, one adds a fixed delay; compare latency percentiles and the per-upstream share from the log | strategy advice |
| E3 | What happens when an upstream dies under load? | kill one mid-run; count errors; time from kill to the health event; with active checks on/off and retries 0/1 | failover claims, default thresholds |
| E4 | Is the stale keep-alive reset real, and do retries hide it? | upstream with a 1 s keep-alive timeout, requests spaced around that boundary; count resets with retries 0 vs 1 | the "race not reproduced" gap |
| E5 | Does the connect timeout work against a real black hole? | iptables DROP on one upstream port (mode 1); time to failure with `CONNECT_TIMEOUT_MS` 3000 and the retry onto another upstream | the "untested" connect-timeout note |
| E6 | Which error does a closed port give? | loopback closed port; (mode 2 only) closed port on another host | `EHOSTUNREACH` coverage |
| E7 | Is memory really flat while streaming? | pipe a large file (about 1 GB) through the proxy, sample RSS from `/proc` | "memory stays flat" (design claim, never measured) |
| E8 | Do the counters survive a long mixed run? | 30 minutes, random client aborts and upstream resets, then check every active count is 0 | lease-leak safety |
| E9 | What does graceful shutdown do to in-flight requests? | SIGTERM during slow requests under load | untested shutdown |

Also recorded with every run: date, Node version, proxy commit, `nproc`, CPU steal from `top`/`mpstat`, and the exact
command. Ampere cores on a free shared tier can be noisy, so spread matters more than any single number.

## Safety and rules this plan follows

- No real money or credentials; test apps only. No secrets in the repo or in logs.
- NeoCBS on A1 is not touched in mode 1 (not even read-only after today's status check).
- No public exposure, no DNS and no certificate work without a separate OK (step 4h).
- Public repo: placeholders for IPs, no server names beyond `portfolio-a2`, raw result files contain no IPs.
- ASCII only. No benchmark number is written anywhere unless it came out of a saved raw result.

## Decisions needed from you

1. OK to start 4a (local code and tests, no servers)? Recommended: yes.
2. OK for 4b-4d on A2 only, mode 1, no public exposure? Recommended: yes.
3. Mode 2 (a rule in the shared Oracle security list and an iptables rule on A1)? Recommended: NO for now.
4. Public URL for the proxy later (4h)? Decide after the results are in.

## Honest limits to expect

- Absolute throughput on a shared 2-core box says little about production. The comparisons and behaviours are the value.
- One host cannot show failover across machines or real RTT effects; mode 2 would, at the cost of touching shared network rules.
- Defaults may turn out fine, and the honest result may be "not enough difference to change them".
