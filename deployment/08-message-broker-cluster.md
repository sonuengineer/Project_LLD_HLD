# 08 -- H12 message broker: a 3-server cluster run (2026-11-21)

What this is: the H12 broker (`projects/13-message-broker`) was run as a REAL 3-node cluster on three Oracle servers and
measured with the bench in `projects/13-message-broker/bench` (experiments B1-B7). Everything was temporary: no service
was installed, nothing was exposed to the internet, and every rule and file was removed again afterwards.

Placeholders: `<A2_IP>`, `<MICRO_IP>`, `<A1_IP>` are the public IPs (Oracle console, Compute > Instances), used only
for SSH. `<A2_PRIV>`, `<MICRO_PRIV>`, `<A1_PRIV>` are the private addresses inside the VCN; all broker traffic used only
these. Real addresses are never written into this repo.

| Server | Role in the run |
|---|---|
| `portfolio-a2` (ARM, 2 OCPU / 12 GB) | load generator (the bench) + broker A, which the bench starts and kills itself |
| `portfolio-micro` (AMD x86, 1 OCPU / 1 GB) | broker B, plain process, `nice -n 19` |
| `portfolio-a1` (ARM, 2 OCPU / 12 GB, runs NeoCBS) | broker C, plain process, `nice -n 19`; NeoCBS left running and checked every minute |

A mixed-architecture cluster (x86 + ARM) is a useful side effect: the route protocol is plain text, so nothing depends on
byte order or the CPU.

## 8.1 Look before you touch (snapshot, read-only)

Saved locally (NOT in the repo, it contains addresses) for each server: memory, listening ports, `iptables -S INPUT`,
running containers, home folder.

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<SERVER_IP> 'hostname; uname -m; free -m | head -2; ss -ltnH | awk "{print \$4}" | sort;
  sudo -n iptables -S INPUT; sudo -n docker ps --format "{{.Names}} {{.Status}}"; ls -1 ~'
```

What it showed on 2026-11-21 (16:57 UTC): ports 19001-19002 free on all three; A1 running its 4 NeoCBS containers
(web, api, clamav, seaweedfs); the micro had about 650 MB available memory; iptables on all three: accept 22, 80, 443,
ICMP, established, loopback, then `REJECT --reject-with icmp-host-prohibited`.

## 8.2 Ship the exact commit

`dist/` is not in git, so it is built on the PC and appended to the `git archive` tarball (the broker has no runtime
dependencies, so `dist/` is all a server needs to run it).

```bash
cd projects/13-message-broker && npm run build && cd ../..
git archive --format=tar --prefix=h12/ HEAD projects/13-message-broker > h12.tar
tar --force-local -rf h12.tar --transform 's,^projects,h12/projects,' projects/13-message-broker/dist   # Windows: --force-local
ssh -i ~/.ssh/oracle_portfolio ubuntu@<SERVER_IP> 'rm -rf ~/h12 && tar -x -C ~' < h12.tar
```

Pitfall: on Windows, GNU tar reads `C:/...` as "host C, path ..."; `--force-local` stops that.

## 8.3 Node.js on micro and A1 (temporary, checksum verified, no system install)

A2 already had `/opt/node` (v20.20.1) from H11. The other two got the same version inside `~/h12/node`, so deleting
`~/h12` removes it completely. `<ARCH>` is `x64` on the micro and `arm64` on A1.

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<SERVER_IP> 'set -e; V=v20.20.1; F=node-$V-linux-<ARCH>.tar.xz; cd ~/h12
  curl -fsSLO https://nodejs.org/dist/$V/SHASUMS256.txt; curl -fsSLO https://nodejs.org/dist/$V/$F
  grep " $F$" SHASUMS256.txt | sha256sum -c -        # must print: OK
  mkdir node; tar -xJf $F -C node --strip-components=1; rm $F; ./node/bin/node --version'
```

## 8.4 Cloud network: three tagged rules, one per source server

The Oracle security list is shared by all servers in the subnet. One rule per SOURCE address (/32), ports 19001
(client) and 19002 (cluster), each with its own tag so it can be removed exactly. The tool does a dry run first, saves a
backup of the whole list before writing, and re-reads afterwards to prove every other rule is unchanged.

```bash
python deployment/scripts/oci_seclist_rule.py add --cidr <A2_PRIV>/32    --ports 19001-19002 --tag h12-bench-a2           # dry run
python deployment/scripts/oci_seclist_rule.py add --cidr <A2_PRIV>/32    --ports 19001-19002 --tag h12-bench-a2    --apply
python deployment/scripts/oci_seclist_rule.py add --cidr <A1_PRIV>/32    --ports 19001-19002 --tag h12-bench-a1    --apply
python deployment/scripts/oci_seclist_rule.py add --cidr <MICRO_PRIV>/32 --ports 19001-19002 --tag h12-bench-micro --apply
```

Each printed "verified: every other rule is unchanged". Applied 16:58-16:59 UTC.

## 8.5 Host firewall: two ACCEPT rules per server, not saved

The security list is only half of it: each server's own iptables ends in REJECT. On every server, for each of the OTHER
two private addresses (inserted at the top, tagged with a comment, never saved, so a reboot also clears them):

```bash
sudo iptables -I INPUT 1 -s <OTHER_PRIV>/32 -p tcp -m tcp --dport 19001:19002 -m comment --comment h12-bench -j ACCEPT
sudo iptables -S INPUT | grep -c h12-bench     # 2 on each server
```

## 8.6 Brokers B (micro) and C (A1)

Plain processes, lowest CPU priority, bound to the PRIVATE address only (the CLI refuses a non-loopback address unless
`ALLOW_NON_LOOPBACK=1`, because the broker has no authentication). Each lists the other in `ROUTES`; broker A on A2 is
started by the bench and dials both.

```bash
ssh -n -i ~/.ssh/oracle_portfolio ubuntu@<MICRO_IP> 'cd ~/h12/projects/13-message-broker &&
  HOST=<MICRO_PRIV> CLUSTER_HOST=<MICRO_PRIV> PORT=19001 CLUSTER_PORT=19002 ROUTES=<A1_PRIV>:19002 \
  ROUTE_RECONNECT_MS=500 STATS_INTERVAL_MS=5000 ALLOW_NON_LOOPBACK=1 \
  setsid nohup nice -n 19 ~/h12/node/bin/node dist/index.js > ~/h12/broker.log 2>&1 < /dev/null & exit 0'
# same on A1 with <A1_PRIV> and ROUTES=<MICRO_PRIV>:19002
```

Pitfall hit: without `setsid` and `ssh -n`, the SSH session stays attached to the background process and the command
never returns. Check: each broker's log line shows `"routes":1` (micro <-> A1 connected over the private network).

## 8.7 Run the experiments on A2

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'cd ~/h12/projects/13-message-broker/bench && export PATH=/opt/node/bin:$PATH && npm ci'
# official nats-server for the B2 reference (release tarball, SHA256SUMS checked):
#   curl -fsSLO https://github.com/nats-io/nats-server/releases/download/v2.15.3/nats-server-v2.15.3-linux-arm64.tar.gz
#   curl -fsSLO https://github.com/nats-io/nats-server/releases/download/v2.15.3/SHA256SUMS
#   grep " nats-server-v2.15.3-linux-arm64.tar.gz$" SHA256SUMS | sha256sum -c -
ssh -n -i ~/.ssh/oracle_portfolio ubuntu@<A2_IP> 'cd ~/h12/projects/13-message-broker/bench &&
  PATH=/opt/node/bin:$PATH REMOTE_NODES=<MICRO_PRIV>:19001:19002,<A1_PRIV>:19001:19002 \
  NATS_SERVER_BIN=$HOME/h12/nats-server-v2.15.3-linux-arm64/nats-server BENCH_COMMIT=<commit> \
  setsid nohup node run.mjs all --label=a2-micro-a1 > ~/h12/bench.log 2>&1 < /dev/null & exit 0'
```

Started 17:03:30 UTC, commit `43c42d1`. While it ran, a watcher on the PC checked every minute that A1 still had its 4
NeoCBS containers up.

Which experiment used which servers: B1, B2 and B5 ran on A2 alone (one broker; B2 also the real nats-server); B3, B4,
B6 and B7 used all three brokers over the private network.

### What went wrong during the run (both in the measuring tool, not the broker)

1. **B2 crashed the first run (17:06:59 UTC).** nats-server prints "Server is ready" to stderr; the bench's process
   helper only watched stdout, and the never-finished readiness promise rejected when nats-server was stopped normally
   after its first B2 run. That unhandled rejection ended the whole bench process. B1 had already finished and its file
   was saved. Fix (commit `c856b80`, bench code only): look for the ready line in stderr too, and await it. B2-B7 were
   then run as part 2 (17:08:20-17:23:47 UTC). The broker code is identical in both parts.
2. **The crash orphaned that nats-server** (loopback only, port chosen at random). Found by the after-snapshot of A2
   (an extra listening port on 127.0.0.1) and stopped by its PID. Nothing was reachable from outside.

Earlier, on the PC dry run, B5 had a bug of the same kind: it waited for a PAUSED socket to notice that the server closed
it, which a paused socket never does. B5 now reads the drop from the broker's own counter.

## 8.8 Results

Copied home (with `tar` over SSH) into `projects/13-message-broker/bench/reference-results/`:

| Folder | Commit | Contains |
|---|---|---|
| `a2-micro-a1-part1` | `43c42d1` | `b1.json` (the run crashed in B2 before writing its summary) |
| `a2-micro-a1-part2` | `c856b80` | `b2.json`-`b7.json`, `SUMMARY.md`, and `b7-remote-brokers.json`: the final stats line and the RSS range of brokers B and C, copied from their own logs |

Scanned for addresses before committing: none. The README section "Measured on real servers" is generated from these
files by `bench/update-readme.mjs`; the interpretation above the tables is in the project README.

## 8.9 Cleanup and proof (17:24-17:26 UTC)

```bash
# brokers B and C: the pattern "[h]12" cannot match pkill's own command line (the H11 lesson)
ssh -i ~/.ssh/oracle_portfolio ubuntu@<SERVER_IP> 'pkill -f "[h]12/node/bin/node dist/index.js"; pgrep -fc "[h]12/node/bin/node" || true'
# on all three: delete every iptables rule with the h12-bench comment, then the folder
ssh -i ~/.ssh/oracle_portfolio ubuntu@<SERVER_IP> 'while sudo iptables -S INPUT | grep -q h12-bench; do
  r=$(sudo iptables -S INPUT | grep -m1 h12-bench | sed "s/^-A /-D /"); eval sudo iptables $r; done
  sudo iptables -S INPUT | grep -c h12-bench; rm -rf ~/h12'
# the three cloud rules, each removed by its tag (backup + verification each time)
python deployment/scripts/oci_seclist_rule.py remove --tag h12-bench-a2 --apply
python deployment/scripts/oci_seclist_rule.py remove --tag h12-bench-a1 --apply
python deployment/scripts/oci_seclist_rule.py remove --tag h12-bench-micro --apply
python deployment/scripts/oci_seclist_rule.py show     # back to: TCP 22, 80, 443 and ICMP from anywhere
```

Proof: an after-snapshot of each server (same command as 8.1) compared line by line with the before-snapshot, memory
lines excluded:

| Server | Difference |
|---|---|
| `portfolio-micro` | none |
| `portfolio-a1` | none, except the ORDER in which `docker ps` listed the 4 NeoCBS containers (all 4 up). The watcher also found all 4 up at every check during the run |
| `portfolio-a2` | first: one extra listening port on 127.0.0.1 (the orphaned nats-server, see above); after stopping it: none |

## 8.10 Timeline (UTC, 2026-11-21)

| Time | What |
|---|---|
| 16:57 | before-snapshots of A2, micro, A1 |
| 16:58 | code shipped to all three (`git archive` of `43c42d1` + `dist/`) |
| 16:58 | Node v20.20.1 (checksum OK) into `~/h12/node` on micro and A1 |
| 16:58-16:59 | security-list rules `h12-bench-a2`, `h12-bench-a1`, `h12-bench-micro` added (TCP 19001-19002, /32 sources) |
| 16:59 | iptables ACCEPT rules (comment `h12-bench`) on all three, 2 each |
| 17:00-17:02 | brokers B (micro) and C (A1) started, route between them up |
| 17:03:30 | bench deps and nats-server v2.15.3 (checksum OK) on A2; bench part 1 started (commit `43c42d1`) |
| 17:06:59 | part 1 crashed in B2 (bench bug, see 8.7); B1 results saved |
| 17:08:20 | bench fix committed (`c856b80`), shipped to A2; part 2 (B2-B7) started |
| 17:23:47 | part 2 finished, including the 10-minute soak (B7) |
| 17:24 | final stats of brokers B and C copied from their logs; results copied to the PC |
| 17:24:53 | brokers stopped; iptables rules removed (0 left on each); `~/h12` deleted on all three |
| 17:25:18 | the three security-list rules removed by tag, list verified back to 22/80/443/ICMP |
| 17:25:49 | after-snapshots match the before-snapshots (orphaned nats-server on A2 found and stopped first) |

Rules were open from 16:58 to 17:25 UTC, only between the three servers' private addresses, only TCP 19001-19002.
