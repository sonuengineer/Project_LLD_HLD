# H12 -- NATS-style message broker: plan

Status (2026-11-21): stages 1-3 DONE (single server with queue groups, headers, no-responders, slow-consumer protection
and graceful close; full-mesh cluster with interest propagation, one-hop forwarding, cluster-wide queue groups, re-dial
and client failover; 138 tests incl. interop with the official `nats` client; 34 mutation checks, 33 caught, 1 explained
in README.md). Stages 4-5 not started.

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

## Next step

Stage 4: first the bench tools locally (no servers), then the server run, which needs your OK for the topology above.
