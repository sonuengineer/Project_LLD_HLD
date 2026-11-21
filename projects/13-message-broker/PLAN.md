# H12 -- NATS-style message broker: plan

Status (2026-11-21): stages 1-3 DONE (single server with queue groups, headers, no-responders, slow-consumer protection
and graceful close; full-mesh cluster with interest propagation, one-hop forwarding, cluster-wide queue groups, re-dial
and client failover; 138 tests incl. interop with the official `nats` client; 34 mutation checks, 33 caught, 1 explained
in README.md). Stage 4 DONE 2026-11-21: measured on portfolio-a2 + portfolio-micro + portfolio-a1 (B1-B7), all
temporary rules and files removed and the servers verified against snapshots; results in README.md ("Measured on real
servers"), raw files in bench/reference-results/, server steps in deployment/08-message-broker-cluster.md. Stage 5 left.

## Why this project, and how it differs from H5

| | H5 minikafka (done) | H12 (this plan) |
|---|---|---|
| Model | log: messages are stored, consumers read by offset, replay is possible | subject-based pub/sub: a message goes to whoever is subscribed RIGHT NOW, then it is gone |
| Delivery | at-least-once (commit after processing) | at-most-once (core NATS semantics); no persistence |
| Routing | topic + partition | subjects with wildcards (`orders.*.created`, `orders.>`), queue groups |
| Cluster | simulated: brokers are objects in ONE process, "network failure" is a flag | REAL: separate processes on separate servers, real TCP between them, a real node can be killed |
| What it teaches | durability, replication, ISR, consumer offsets | routing, interest propagation, fan-out, back-pressure, failover with message loss you can measure |

## Decisions (one recommendation each)

- **Language: TypeScript on Node 20, zero runtime dependencies** (same as H11). The protocol is text plus byte-counted
  payloads, which Node streams handle well, and the H11 tooling (vitest, bench runner, systemd unit) can be reused.
- **Client protocol: wire-compatible with the core NATS client protocol** (`INFO`, `CONNECT`, `PUB`, `HPUB`, `SUB`, `UNSUB`,
  `MSG`, `HMSG`, `PING`, `PONG`, `+OK`, `-ERR`). Reason: the OFFICIAL NATS client library (`nats` on npm, added as a
  devDependency only) can then be used in tests as an independent check, the same way the MCP server (A3) was tested
  against the official SDK. If a part does not interoperate, it is written down, not hidden.
- **Cluster protocol: our own, NOT compatible with real NATS routes.** Real NATS route compatibility is a large target and
  is not the learning goal. It will be documented as "inspired by", never claimed as compatible.
- **No authentication in the first stages**, so the server only ever listens on loopback or a PRIVATE address. Token auth
  (`auth_token` in `CONNECT`) is a later stage. It is never exposed to the internet.
- **No persistence.** That is H5's job; JetStream-like storage is explicitly out of scope.

## Stages

| Stage | What | Proves it |
|---|---|---|
| 1 | Single server: streaming protocol parser (frames split across TCP packets, byte-counted payloads, max control line, max payload), subject trie with `*` and `>`, `SUB` / `UNSUB` (incl. auto-unsubscribe after N messages), `PUB` -> `MSG` fan-out, `PING`/`PONG` both ways (server drops a client after missed pongs), `verbose` (`+OK`), `-ERR` for bad input | unit tests for the parser and the trie; integration tests over real TCP; interop with the official `nats` client (publish, subscribe, wildcards, request/reply via `_INBOX`) |
| 2 | Queue groups (one member of a group gets each message), headers (`HPUB`/`HMSG`), slow-consumer protection (per-client pending-bytes limit -> `-ERR 'Slow Consumer'` and disconnect, so one slow reader cannot eat the server's memory), graceful shutdown (reusing the H11 lesson: sweep idle connections) | tests incl. a deliberately slow subscriber; queue-group distribution test; interop |
| 3 | Cluster: full-mesh routes between servers, interest propagation (a server only forwards a subject to a peer that has a subscriber for it), loop-free forwarding (a message that arrived from a route is never sent to another route), queue groups cluster-wide (exactly one member in the whole cluster gets each message; prefer a local member), route reconnect with backoff, clients fail over using a server list | 3 servers in one test process on ephemeral ports; tests for "no duplicate delivery in a mesh", "no forwarding without interest", "queue group gets each message once cluster-wide", "a killed route reconnects" |
| 4 | Run it on the Oracle servers and MEASURE (H11 method: raw JSON results, median of runs, CPU steal recorded, every table generated, nothing typed) | see experiments below |
| 5 | Interview bank to 100+ questions, deployment doc with dates, portfolio entry | validator `[OK]` |

Every stage follows the H11 rules: each behaviour has a test, key tests are proven to fail by breaking the code on purpose,
README lists what is NOT implemented, interview questions only about code that exists.

## Experiments for stage 4 (planned, nothing measured yet)

| # | Question |
|---|---|
| B1 | Throughput and latency of publish -> deliver on one node, for 1, 10 and 100 subscribers (fan-out cost) |
| B2 | Same on the real `nats-server` binary on the same machine, as a reference point (honest comparison: ours will be slower; the question is by how much and why) |
| B3 | Cross-node delivery: publisher on node A, subscriber on node B -- added latency of one route hop |
| B4 | Kill a node under load (no warning): how many messages are lost (at-most-once makes loss expected; the number is the point), how long clients take to reconnect to another node |
| B5 | Slow consumer: does the protection disconnect it before server memory grows without limit (memory sampled like H11's E7) |
| B6 | Queue group balance across the cluster |
| B7 | Soak with random client disconnects: subscription counts and memory return to baseline (leak check) |

## Where it would run (decide at stage 4, needs your OK then)

Three nodes need three machines:

- `portfolio-micro` (AMD x86, 1 GB) + `portfolio-a2` (ARM) + `portfolio-a1` (ARM) -- a real 3-node, mixed-architecture
  cluster. A1 runs NeoCBS, so it would be used exactly like the H11 two-host run: temporary, lowest CPU priority, one tagged
  rule (private addresses only), snapshot before and verified cleanup after. **Recommended.**
- Alternative if A1 must stay untouched: 2 nodes on micro + A2, and a third node as a second process on A2 (weaker: two of
  the three nodes share a machine).

Network: cluster and client ports opened only between the servers' PRIVATE addresses (/32 each) with the tagged-rule tool
`deployment/scripts/oci_seclist_rule.py`. Nothing public.

## Not in scope

Persistence / JetStream, real NATS route or leaf-node compatibility, TLS, accounts and multi-tenancy, a public endpoint,
running it on Render or other free tiers.

## Stage 4 run plan (written 2026-11-21, nothing on the servers yet)

Done locally: `bench/` (B1-B7, raw JSON results, generated SUMMARY.md), dry-run on the PC. The dry run found a bug in
the TOOL, not the broker: B5 waited for the paused subscriber to see its socket close, which a paused socket never does.
B5 now reads the drop from the broker's own counter; an in-process probe confirmed the broker drops at the limit.

Server steps (only after your OK):

| # | Step | Where | Undo |
|---|---|---|---|
| 1 | Record a "before" snapshot: listening ports, iptables INPUT, running containers (A1), free memory | all three | -- |
| 2 | Ship the built code with `git archive` (no `.git`, no secrets) to `~/h12` | all three | `rm -rf ~/h12` |
| 3 | Node.js: A2 already has `/opt/node`. On micro (x64) and A1 (arm64): official tarball, SHA-256 checked, unpacked into `~/h12/node` -- no system-wide install | micro, A1 | removed with `~/h12` |
| 4 | Oracle security list: three tagged rules (`h12-bench-a2`, `h12-bench-a1`, `h12-bench-micro`), TCP 19001-19002, each from ONE private address (/32), with `oci_seclist_rule.py` (dry run, backup, verification) | Oracle network | `remove --tag ... --apply` |
| 5 | iptables: ACCEPT TCP 19001-19002 from the other two private addresses, inserted before the REJECT rule; not saved, so a reboot also removes them | all three | `iptables -D` the same rules |
| 6 | Brokers: `nice -n 19` plain processes (no systemd unit), client port 19001, cluster port 19002, bound to the PRIVATE address, `MAX_PENDING` default | micro, A1 (remote); A2's broker is started by the bench | kill the process |
| 7 | Run B1-B7 from A2 (`REMOTE_NODES=<micro>:19001:19002,<a1>:19001:19002`); B5 and B1 stay on A2 only; B2 downloads the official nats-server release (checksum checked) into `~/h12` on A2 | A2 | -- |
| 8 | Stop everything, remove rules (step 4 + 5), delete `~/h12` on micro and A1, compare with the "before" snapshot | all three | -- |
| 9 | Results: raw files into `bench/reference-results/`, README "Measured" section generated from them, dated server log in `deployment/` | repo | -- |

Expected time on the servers: about 1 hour, most of it the 10-minute soak (B7) and the 3 runs of each experiment.
A1 (NeoCBS) gets only a low-priority broker process, two not-saved iptables rules and a temporary folder, and is
checked against its snapshot afterwards, exactly like the H11 two-host run.

If you prefer A1 untouched: micro + A2 only, and the third node is a second broker process on A2 (weaker: two of the three
brokers share a machine, so B3/B4/B6 cross a real network for only one of the two peers).

## Next step

Stage 5: interview bank from 45 to 100+ questions (the new ones from the stage 4 findings: the 12x gap to nats-server,
the B5 memory multiple, the B4 loss window), and the portfolio entry. Optional: investigate the B5 memory question.
