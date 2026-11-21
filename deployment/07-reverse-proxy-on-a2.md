# Step 7 -- Run the H11 reverse proxy on the second A1 server (portfolio-a2) and measure it

Dates: single-host work and the service on 2026-11-20; the two-host run (section 7.9) on 2026-11-21.

Project code: `projects/12-reverse-proxy` (TypeScript, zero runtime dependencies). Plan: `projects/12-reverse-proxy/STAGE4_PLAN.md`.
Placeholders: `<A2_IP>` is the public IP of `portfolio-a2` (Oracle console, Compute > Instances).

Scope of sections 7.1-7.8 (2026-11-20): everything stays on A2, over loopback. Nothing is exposed to the internet, no Oracle
security-list rule is added, and the first A1 server (which runs another application) is not touched. Section 7.9
(2026-11-21) is the two-host run: it added TEMPORARY rules and removed them again.

## 7.1 Look before you touch (read-only)

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'hostname; uname -m; free -m | head -2; ss -ltn; sudo -n iptables -S INPUT | head'
```

What was found on 2026-11-20: aarch64 Ubuntu 24.04, about 11 GB of free memory, Caddy answering on port 80, no Node.js, and an
iptables INPUT chain that accepts only ports 22, 80 and 443 and then REJECTs with `icmp-host-prohibited`.

Consequence worth knowing: a closed port on ANOTHER host behind that rule gives the client "No route to host"
(`EHOSTUNREACH`), not "connection refused". The proxy's retry list includes `EHOSTUNREACH`. This was NOT measured (the
experiments ran on one host, where a closed port gives `ECONNREFUSED`).

## 7.2 Ship the exact commit (no git needed on the server)

From your PC, inside the repo (use the commit you want to measure):

```bash
git archive --format=tar <COMMIT> projects/12-reverse-proxy | \
  ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'rm -rf ~/h11 && mkdir -p ~/h11 && tar -x -C ~/h11'
```

`git archive` ships only committed files, so a result file can name the commit it came from.

## 7.3 Install Node.js (official arm64 tarball, checksum verified)

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'set -e
mkdir -p /tmp/node-dl && cd /tmp/node-dl
curl -fsSLO https://nodejs.org/dist/v20.20.1/node-v20.20.1-linux-arm64.tar.xz
curl -fsSLO https://nodejs.org/dist/v20.20.1/SHASUMS256.txt
grep " node-v20.20.1-linux-arm64.tar.xz$" SHASUMS256.txt | sha256sum -c -      # must print: OK
sudo tar -xJf node-v20.20.1-linux-arm64.tar.xz -C /opt
sudo ln -sfn /opt/node-v20.20.1-linux-arm64 /opt/node
/opt/node/bin/node --version
rm -rf /tmp/node-dl'
```

The checksum file comes from the same site over TLS. It is not a signature check (nodejs.org also publishes GPG
signatures); that was a conscious shortcut for a throw-away test box.

## 7.4 Install dependencies and run the tests ON THE SERVER

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'export PATH=/opt/node/bin:$PATH; cd ~/h11/projects/12-reverse-proxy
npm ci && (cd bench && npm ci) && npx tsc --noEmit && npx vitest run'
```

`npm ci` installs exactly what the lock file says (with integrity hashes). The test suite includes tests that start the real
CLI and send it SIGTERM; those only run on Linux/macOS, so this was the first place they could run.
Result on 2026-11-20 (commit `82da2b7`): 105 passed, 0 failed.

## 7.5 Run the experiments

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'export PATH=/opt/node/bin:$PATH; cd ~/h11/projects/12-reverse-proxy
npx tsc -p tsconfig.build.json
cd bench
BENCH_QUICK=1 node run.mjs all --label=dry           # short dry run first: checks that everything works
BENCH_COMMIT=<COMMIT> nohup node run.mjs e1 e2 e3 e4 e5 e6 e7 e9 --label=a2-full > ~/run-full.log 2>&1 < /dev/null &
BENCH_COMMIT=<COMMIT> SOAK_SECONDS=1800 nohup node run.mjs e8 --label=a2-soak > ~/run-soak.log 2>&1 < /dev/null &   # only after the first one finishes'
```

- Run them one after another, never at the same time: they share the two CPU cores.
- `BENCH_COMMIT` tells the runner which commit the code is (the server copy has no `.git`).
- Each run writes `bench/results/<timestamp>-<label>/` with `env.json`, one JSON file per experiment, and a generated
  `SUMMARY.md` (every table cell is computed from the raw data). The run also records CPU steal: how much CPU time the
  hypervisor gave to other tenants (high steal means noisy numbers).
- E5 inserts one temporary iptables DROP rule on loopback for the dead upstream's port. The script removes it in a
  `finally` block, and a detached watchdog removes it after 120 s even if the script is killed. Check afterwards:
  `sudo iptables -S OUTPUT | grep DROP` must print nothing.
- Copy the results home: `scp -r ubuntu@<A2_IP>:~/h11/projects/12-reverse-proxy/bench/results/<folder> .`

## 7.6 Install it as a hardened systemd service (nothing public)

The service files live in `projects/12-reverse-proxy/deploy/`. The script creates a login-less system user, copies only
`dist/` to `/opt/reverse-proxy`, puts the settings in `/etc/reverse-proxy.env` (never overwritten if it exists), and installs
the unit. It starts nothing.

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'export PATH=/opt/node/bin:$PATH; cd ~/h11/projects/12-reverse-proxy
npx tsc -p tsconfig.build.json && sudo bash deploy/install-on-ubuntu.sh "$PWD"'
```

Try it with the bundled demo server (a throw-away test upstream; replace it with your real application later):

```bash
sudo systemctl start demo-upstream reverse-proxy
curl -si http://127.0.0.1:8080/          # 200, body "demo", header "via: 1.1 h11-proxy"
sudo ss -ltnp | grep node                # the proxy must show 127.0.0.1:8080 only
sudo journalctl -u reverse-proxy -n 5 -o cat          # one JSON line per request
systemd-analyze security reverse-proxy --no-pager | tail -2
```

What was seen on 2026-11-20: the proxy ran as the `reverse-proxy` user, listened on 127.0.0.1 only, a request from outside
the host got no answer, and `systemd-analyze security` rated the unit **5.8 MEDIUM** (more hardening is possible: system-call
filters and capability limits were not added).

Behaviour checked on the real service:

- Upstream stopped: the first two requests answered 502, the third 503 (each GET makes two attempts and every failed attempt
  counts, so three failures arrive within two requests). After 12 s: 503 with `Retry-After: 1`, and the journal shows both
  health events (passive "ejected for 10000 ms after 3 consecutive failures", active "2 health checks failed").
- Upstream started again: the next request within 12 s answered 200 and the journal shows "2 health checks passed".
- `systemctl stop reverse-proxy` took 0.03 s, `Result=success`, exit status 0 (no request was in flight at that moment).

After the check, both services were stopped and disabled. The files stay installed so a later start is one command.

Remove everything again (the exact line is also printed by the install script):

```bash
sudo systemctl disable --now reverse-proxy demo-upstream
sudo rm -rf /opt/reverse-proxy /opt/reverse-proxy-demo /etc/reverse-proxy.env \
  /etc/systemd/system/reverse-proxy.service /etc/systemd/system/demo-upstream.service
sudo userdel reverse-proxy && sudo systemctl daemon-reload
```

## 7.7 What the measurements showed

The full tables are in `projects/12-reverse-proxy/README.md` ("Measured on a real server") and the raw files in
`projects/12-reverse-proxy/bench/reference-results/`. In one line each:

- through the proxy the server handled about a quarter of the direct request rate on this shared 2-core box;
- least-connections beat round-robin on throughput and median latency with a slow upstream, but not on p99;
- with one retry, killing an upstream under load showed no failures to the client;
- a real black hole costs every early request the full connect timeout until the upstream is ejected;
- a 1 GiB download raised proxy memory by about 40 MiB, not by 1 GiB;
- a 30-minute soak ended with every active counter at 0;
- measuring graceful shutdown exposed a real defect (the process lingered about 3 s after its work was done because idle
  keep-alive connections were never swept); it was fixed and re-measured: 4540 ms before, 1611 ms after.

## 7.8 What was NOT done

- No public URL, DNS name or certificate: the proxy only listens on loopback (single host) or is reached over the private
  network (two-host run, 7.9).
- Not measured: a whole machine failing (only processes were killed), uploads through the proxy, per-process CPU, the cost
  of health probes, any production error rate.
- Defaults were reviewed against the data and left unchanged.

## 7.9 Two-host measurement (2026-11-21): proxy on A2, test upstreams on A1

Goal: measure what one machine cannot show: a real network hop, and how a closed port on ANOTHER machine fails.
Layout: load generator + proxy on `portfolio-a2`, two small test upstreams on `portfolio-a1` (which also runs another
application; it was only touched as described here and restored afterwards).

Timeline (UTC):

| Time | Step |
|---|---|
| 11:56 | Read-only snapshot of A1: load, containers, `iptables -S INPUT` (7 rules), listening ports, home folder |
| 11:57 | Node.js unpacked into A1's HOME folder (no system-wide install, checksum verified); two test upstreams started at `nice 19`, bound to A1's PRIVATE address only |
| 11:57 | One A1 host firewall rule added, tagged `h11-bench-temp`: TCP 18001, 18002, 18004 from A2's private address only (not saved, so a reboot also removes it) |
| 11:57 | One rule added to the cloud network rules (Oracle security list), tagged `h11-bench-temp`: TCP 18001-18004 from A2's private address (/32) only |
| 11:58-12:03 | Experiments X1-X4 from A2 (about 5 minutes) |
| 12:03 | A1: upstreams stopped, firewall rule deleted, folder deleted; state compared with the 11:56 snapshot: identical |
| 12:04 | Cloud network rule removed; the tool re-read the rule list and verified the other 4 rules were unchanged |

### The cloud network rule (Oracle security list)

The tool `deployment/scripts/oci_seclist_rule.py` exists because `update_security_list` REPLACES the whole rule list: a
careless call can delete the SSH/80/443 rules. The tool reads the list, changes only one tagged rule, shows the difference,
writes a backup of the full list to `~/.oci/seclist-backups/` (outside the repo, it contains resource IDs), and re-reads
afterwards to prove nothing else changed. It does a dry run unless `--apply` is given.

```bash
cd deployment/scripts
~/.oci-cli-venv/Scripts/python -I -u oci_seclist_rule.py show
~/.oci-cli-venv/Scripts/python -I -u oci_seclist_rule.py add --cidr <A2_PRIVATE_IP>/32 --ports 18001-18004 --tag h11-bench-temp           # dry run
~/.oci-cli-venv/Scripts/python -I -u oci_seclist_rule.py add --cidr <A2_PRIVATE_IP>/32 --ports 18001-18004 --tag h11-bench-temp --apply
# ... experiments ...
~/.oci-cli-venv/Scripts/python -I -u oci_seclist_rule.py remove --tag h11-bench-temp --apply
```

Before the change the list had 4 rules (TCP 22, 80, 443 and ICMP, from anywhere), attached to the one subnet that all three
servers use. The rule applies to every server in that subnet, but only A1 had something listening and a matching host
firewall rule.

A mistake of mine, recorded honestly: the first `--apply` WROTE the rule correctly, then crashed in its own verification
step (it compared egress rules with the ingress key). I verified by hand against the backup (4 old rules unchanged, 1 new
rule, egress identical), fixed the bug (commit `75f898b`), and the removal later ran with the automatic verification.

### On A1 (the upstream machine)

```bash
# Node in the home folder, no sudo (same checksum check as in 7.3), then:
PORT=18001 HOST=<A1_PRIVATE_IP> NAME=fast             nohup nice -n 19 ./node/bin/node upstream.mjs > fast.log 2>&1 < /dev/null &
PORT=18002 HOST=<A1_PRIVATE_IP> NAME=slow DELAY_MS=40 nohup nice -n 19 ./node/bin/node upstream.mjs > slow.log 2>&1 < /dev/null &
sudo iptables -I INPUT 1 -p tcp -s <A2_PRIVATE_IP> -m multiport --dports 18001,18002,18004 \
  -m comment --comment h11-bench-temp -j ACCEPT
```

Port 18003 was allowed by the cloud rule but NOT by A1's firewall (so A1 REJECTs it), port 18004 was allowed by both but
nothing listened on it, and port 18005 was not allowed by the cloud rule at all (silently dropped). That gives the three
failure kinds of experiment X4.

### On A2 (the proxy machine)

```bash
cd ~/h11/projects/12-reverse-proxy/bench
nohup env BENCH_COMMIT=<COMMIT> REMOTE_HOST=<A1_PRIVATE_IP> REMOTE_FAST_PORT=18001 REMOTE_SLOW_PORT=18002 \
  REMOTE_REJECTED_PORT=18003 REMOTE_REFUSED_PORT=18004 REMOTE_BLACKHOLE_PORT=18005 \
  node run.mjs x1 x2 x3 x4 --label=a2-a1-two-host > ~/h11/run-twohost.log 2>&1 < /dev/null &
echo $! > ~/h11/twohost.pid          # wait on THIS process id, not on a name pattern (see below)
```

### Cleanup on A1, and the proof

```bash
sudo iptables -D INPUT -p tcp -s <A2_PRIVATE_IP> -m multiport --dports 18001,18002,18004 \
  -m comment --comment h11-bench-temp -j ACCEPT
rm -rf ~/h11-bench
sudo iptables -S INPUT; ss -ltn; docker ps        # compared line by line with the 11:56 snapshot
```

Result: the INPUT chain was identical (7 rules), the listening ports were identical, the home folder was empty again and
the other application's containers were all up and healthy before, during and after (load on A1 stayed below 0.5).
After the cloud rule was removed: SSH to both servers OK, A1 port 80 answered 200, A1's HTTPS site answered 200 with a
valid certificate when called by its name, and the test port from A2 to A1 was blocked again.

Lesson learned twice: `pkill -f <pattern>` and `pgrep -f <pattern>` also match the shell whose command line CONTAINS the
pattern. A cleanup with `pkill -f "...node upstream.mjs"` killed its own ssh session after stopping the upstreams (the
rest was then done with exact commands), and a wait loop with `pgrep -f "node run.mjs"` waited for itself. Use a saved
process id (`kill -0 $PID`) or exact commands instead.

Results: `projects/12-reverse-proxy/bench/reference-results/a2-a1-two-host/` and the README section "Two machines".
