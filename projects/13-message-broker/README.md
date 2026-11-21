# H12 -- NATS-style message broker

A hand-written pub/sub message broker in TypeScript on Node's `net` module, with **zero runtime dependencies**. It speaks
the core NATS client protocol, so the official `nats` client library connects to it unchanged.

Status (2026-11-21): **stages 1-3 of 5 done** -- a single server with queue groups, headers, slow-consumer protection and
graceful close, and a full-mesh cluster of servers. The measurements on real servers are stage 4 (see [PLAN.md](PLAN.md)).
Nothing has been measured or deployed yet, so this README contains no performance numbers.

## Stage 3: cluster (our own route protocol, NOT compatible with real NATS routes)

Every broker opens a second port for other brokers ("routes"). `src/route.ts` defines the protocol:
`RINFO` (handshake), `RS+` / `RS-` (interest), `RMSG` (a message for the peer's local subscribers).

| Rule | Where | Proven by (`test/cluster.test.ts`, 3 brokers in one process over loopback) |
|---|---|---|
| Interest propagation: a broker announces each distinct subject/queue its CLIENTS use, once (0 -> 1) and withdraws it once (1 -> 0); a disconnect counts as unsubscribe | `interestUp` / `interestDown` | "interest is counted", "nothing is forwarded to a broker that has no interest" |
| A new peer gets the full current interest on connect | `handshake` | "a broker that joins later learns the existing interest" |
| One hop only: a message that came from a route is never sent to another route, so a full mesh has no loops and no duplicates | `fromRoute` | "no duplicates in a full mesh" (100 messages, 3 subscribers on 3 brokers, each gets exactly 100; the receiving brokers forward 0) |
| Queue groups cluster-wide: the origin broker picks ONE destination per group -- a local member if any, else exactly one peer; the RMSG lists the groups that peer must serve | `publish`, `fromRoute` | "a local member is preferred" (0 route messages), "each message goes to exactly ONE remote member", "plain subscribers and a queue group on the same peer" |
| At most one RMSG per peer per message, carrying both "deliver to your plain subscribers" and the queue groups | `publish` | same test checks the exact route message count |
| Duplicate connections (both sides dialled): keep the one dialled by the smaller server id; both ends compute the same answer | `handshake` | "exactly one route per pair, and it stays that way" (every test dials both ways) |
| Self-route (a broker listed in its own ROUTES) is detected and never dialled again | `handshake` | self-route test |
| A dialled route that drops is re-dialled with exponential backoff (doubling, capped at 32x `reconnectMs`) | `scheduleDial` | "a broker that restarts on the same cluster port is re-dialled and gets the interest again" |
| Headers and reply subjects cross the hop unchanged | `encodeRmsg` | headers test; request/reply across brokers with the official client |
| Client failover: a client with a server list reconnects to another broker and re-subscribes; the cluster re-learns its interest | (client side + interest propagation) | official `nats` client: broker A killed, client moves to B, a message published on C still arrives |

Framing (split reads, byte-counted payloads, control-line limit) was moved from `parser.ts` into `src/framer.ts`, so the
client parser and the route parser share it.

Stage 3 limits, stated honestly:
- Messages published before a new subscription's `RS+` reaches the publisher's broker are not forwarded (at most once).
- A message in flight on a route when a broker dies is lost. Nothing retries it.
- Routes have no PING/PONG of their own yet (TCP keep-alive only), and no slow-route limit like `maxPending`.
- Full mesh only: every broker must be able to reach every other one directly. No gossip of peer addresses.
- No authentication on routes either: the cluster port must only ever be on a private network.

## Stage 2 additions

| Feature | Where | Proven by |
|---|---|---|
| Queue groups (`SUB subject group sid`): each message goes to ONE member per group, picked at random; plain subscribers still get every message; different groups each get a copy; a publisher with `echo:false` is never picked for its own message | `Broker.publish` | `test/stage2.test.ts`, interop (100 messages over 2 connections, each handled exactly once) |
| Headers: `HPUB` in, `HMSG` out to clients that sent `headers:true`; clients that did not get a plain `MSG` with the body only. Header + body count against `max_payload`; the header block must start with `NATS/1.0` | `parser.ts`, `Broker.deliver` | parser + stage 2 tests, interop (multi-value header round trip) |
| No responders: a request (PUB with a reply subject) that reaches nobody gets an immediate `NATS/1.0 503` status on the requester's inbox, if it opted in with `headers:true` and `no_responders:true` | `Broker.sendNoResponders` | stage 2 tests, interop (official client's `request()` fails with code 503 in well under its timeout instead of waiting it out) |
| Slow-consumer protection: if a client's unsent bytes (`socket.writableLength`) would pass `maxPending` (default 64 MiB), it is dropped at once and counted in `stats().slowConsumers`; the publisher and other clients carry on | `Broker.deliver`, `Broker.slowConsumer` | stage 2 tests: a paused reader is dropped, a reader that keeps up is not, even when the total sent is far above the limit |
| Graceful close: stop accepting, `end()` every connection so already-queued messages are flushed before the FIN; a peer that never closes is destroyed after `forceMs` | `Broker.close` | stage 2 tests (500 queued messages all arrive; a half-open peer is forced) |

Two honest notes: the slow consumer is destroyed immediately (waiting for its buffer to flush is the memory we want
back), so it usually never sees the `-ERR 'Slow Consumer'`. And the queue member is chosen at random with no preference
for a local member -- that only matters once there is a cluster (stage 3).

## What it does (stage 1)

| Feature | Where | Proven by |
|---|---|---|
| Streaming parser: commands split across TCP reads, payloads read by BYTE COUNT (so a payload may contain `\r\n`) | `src/parser.ts` | `test/parser.test.ts` splits a stream at every offset and byte by byte |
| Limits enforced while reading: control line > `maxControlLine` rejected before its newline arrives; a PUB DECLARING more than `max_payload` rejected before any payload is buffered | `src/parser.ts` | parser + server tests |
| Subjects with `*` (one token) and `>` (one or more trailing tokens); a wildcard only counts as a whole token | `src/subjects.ts` | `test/subjects.test.ts` |
| Subscription trie: matching cost follows subject depth and wildcard branches, not the number of subscriptions; empty branches are pruned on unsubscribe | `src/subjects.ts` | pruning test (`nodeCount()` back to 0) |
| `PUB` -> `MSG` fan-out, once per matching subscription, reply subject carried through | `src/server.ts` | `test/server.test.ts` |
| `UNSUB <sid>` and `UNSUB <sid> <max>` (auto-unsubscribe after max deliveries) | `src/server.ts` | server + interop tests |
| `verbose` (`+OK`), `echo: false` (do not deliver my own messages) | `src/server.ts` | server tests |
| Liveness: server PINGs every `pingIntervalMs`; after `maxPingsOut` unanswered PINGs it sends `-ERR 'Stale Connection'` and closes | `src/server.ts` | server tests with a 50 ms interval |
| Errors: non-fatal ones keep the connection (`Invalid Subject`, `Invalid Publish Subject`); protocol violations close it (`Unknown Protocol Operation`, `Maximum Payload Violation`, `Maximum Control Line Exceeded`, bad `CONNECT`) and remove its subscriptions immediately | `src/server.ts` | server tests, incl. "one bad client does not affect another" |
| Disconnect removes every subscription of that client | `src/server.ts` | server + interop tests check `stats()` returns to 0 |

**Delivery is at most once.** A message goes to whoever is subscribed at that moment and is then forgotten. Nothing
is stored. This is core NATS semantics, and the opposite of H5 (minikafka), which keeps a log.

## Interop with the official client

`test/interop.test.ts` runs the official `nats` npm package (pinned 2.29.3, a devDependency only) against this broker:
connect and read INFO, publish/subscribe with `*` and `>`, ordering of 100 messages from one publisher, request/reply
through the client's `_INBOX`, `subscribe({ max })`, `unsubscribe()`, a 256 KiB payload, the client refusing a payload
over our advertised `max_payload`, and `drain()`/`close()` leaving no connections or subscriptions behind. All pass.

## Mutation checks (2026-11-21)

Each rule was broken on purpose, the suite was run, and the change was reverted. A check "passes" when at least one
test turns red.

| # | Deliberate break | Tests failed |
|---|---|---|
| M1 | no CRLF check after the payload | 1 |
| M2 | no max-payload check | 2 |
| M3 | no early control-line check | 2 |
| M4 | `*` wildcard ignored | 7 |
| M5 | `>` wildcard ignored | 4 |
| M6 | no pruning of empty trie nodes | 2 |
| M7 | auto-unsubscribe off by one | 2 |
| M8 | disconnect leaves subscriptions behind | 7 |
| M9 | `echo: false` ignored | 1 |
| M10 | PONG does not reset the missed-ping count | 1 |
| M11 | publishing to a wildcard subject allowed | 3 |
| M12 | `verbose` always off | 2 |

All 12 caught (counts measured against the stage 1 suite of 88 tests).

Stage 2 checks, against the stage 2 suite of 113 tests:

| # | Deliberate break | Tests failed |
|---|---|---|
| S1 | queue groups ignored (every member gets the message) | 4 |
| S2 | queue pick always the first member | 2 |
| S3 | headers not stripped for clients that did not ask for them | 1 |
| S4 | HMSG sent to clients that did not ask for headers | 1 |
| S5 | no-responders 503 never sent | 2 |
| S6 | no-responders sent without the client's opt-in | 1 |
| S7 | no slow-consumer check | 1 |
| S8 | slow-consumer check counts every byte ever sent (`bytesWritten`) instead of unsent bytes (`writableLength`) | 1 |
| S9 | close destroys sockets instead of flushing them | 1 |
| S10 | close never forces a half-open peer | 1 |
| S11 | HPUB header prefix not checked | 1 |

All 11 caught. After restoring: 113/113 pass (also 5 repeated full runs, 113/113 each).

Stage 3 checks, against the stage 3 suite of 138 tests (the M checks were also re-run there; all still caught):

| # | Deliberate break | Tests failed |
|---|---|---|
| C1 | forward to every peer, interest ignored | 3 |
| C2 | interest withdrawn on the FIRST unsubscribe instead of the last | 1 |
| C3 | no interest sent to a newly connected peer | 2 |
| C4 | duplicate-connection rule not symmetric | 12 |
| C5 | queue group: local member not preferred | 1 |
| C6 | queue group sent to every peer instead of one | 2 |
| C7 | receiver ignores the "deliver to plain subscribers" flag | **0 (not caught)** |
| C8 | no re-dial after a route drops | 1 |
| C9 | receiver serves every local queue group, not only the listed ones | 1 |
| C10 | self-route not detected | 1 |
| C11 | a message from a route forwarded again (loop) | 3 |

C7 is not caught, and it cannot be with these tests. The flag is false only when the sender saw NO plain interest from
that peer, and then the peer has no plain subscriber for the subject, so ignoring the flag changes nothing. The only
exception is the short moment before a brand-new plain subscription's `RS+` arrives. It is kept as a statement of intent
("this copy is for the queue group only"), and it is listed here as not covered instead of being claimed as tested.

After restoring: 138/138 pass (also 8 repeated full runs, 138/138 each).

## NOT implemented yet (honest list)

- Measurements on real servers (stage 4).
- Authentication, TLS, persistence, accounts, max connections, `pedantic` mode.
- Queue member choice inside one broker is random (no round robin, no load awareness).
- No "lame duck" mode: `close()` flushes and ends connections, but does not first tell clients to move elsewhere.
- Operations are accepted before `CONNECT` (nats-server only insists when auth is on; there is no auth here).
- A repeated `sid` on SUB is ignored (the first subscription stays).

## Run it

```
npm install
npm test            # 138 tests: parser, trie, raw TCP, stage 2 features, cluster, official-client interop
npm run build
npm start           # listens on 127.0.0.1:4222
```

PowerShell: `$env:PORT=4333; npm start`. Settings (environment variables): `HOST` (default `127.0.0.1`), `PORT` (4222),
`MAX_PAYLOAD` (1048576), `PING_INTERVAL_MS` (120000), `MAX_PINGS_OUT` (2), `MAX_PENDING` (67108864), and for a cluster
`CLUSTER_PORT`, `CLUSTER_HOST`, `ROUTES` (comma list of `host:port`), `ROUTE_RECONNECT_MS` (1000). There is **no authentication**, so binding
anything but loopback needs `ALLOW_NON_LOOPBACK=1`, and must only ever be a private address.

Try it by hand with any TCP tool (`telnet 127.0.0.1 4222`, or `ncat`):

```
SUB demo.* 1
PUB demo.hi 5
hello
```

and the server answers `MSG demo.hi 1 5` followed by `hello`.

## Files

| File | Purpose |
|---|---|
| `src/framer.ts` | byte-stream framing shared by both protocols: lines, byte-counted payloads, control-line limit |
| `src/parser.ts` | client protocol: what each line means, payload limit, HPUB header checks |
| `src/route.ts` | route protocol between brokers: parser and encoders |
| `src/subjects.ts` | subject validation and the `SubjectTrie` |
| `src/server.ts` | `Broker`: connections, delivery, liveness, errors, stats |
| `src/index.ts` | CLI, environment configuration, loopback guard, SIGINT/SIGTERM |
| `test/helpers.ts` | `Raw` hand-driven protocol client, `startBroker` |
