# H12 -- NATS-style message broker

A hand-written pub/sub message broker in TypeScript on Node's `net` module, with **zero runtime dependencies**. It speaks
the core NATS client protocol, so the official `nats` client library connects to it unchanged.

Status (2026-11-21): **stages 1 and 2 of 5 done** -- a single server with queue groups, headers, slow-consumer
protection and graceful close. Clustering and the measurements come in later stages (see [PLAN.md](PLAN.md)). Nothing has
been measured or deployed yet, so this README contains no performance numbers.

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

## NOT implemented yet (honest list)

- Clustering (stage 3): one server only, so a server crash loses every connection and every in-flight message.
- Authentication, TLS, persistence, accounts, max connections, `pedantic` mode.
- Queue member choice is random, with no preference for a local member (matters from stage 3).
- No "lame duck" mode: `close()` flushes and ends connections, but does not first tell clients to move elsewhere.
- Operations are accepted before `CONNECT` (nats-server only insists when auth is on; there is no auth here).
- A repeated `sid` on SUB is ignored (the first subscription stays).

## Run it

```
npm install
npm test            # 113 tests: parser, trie, raw TCP integration, stage 2 features, official-client interop
npm run build
npm start           # listens on 127.0.0.1:4222
```

PowerShell: `$env:PORT=4333; npm start`. Settings (environment variables): `HOST` (default `127.0.0.1`), `PORT` (4222),
`MAX_PAYLOAD` (1048576), `PING_INTERVAL_MS` (120000), `MAX_PINGS_OUT` (2), `MAX_PENDING` (67108864). There is **no authentication**, so binding
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
| `src/parser.ts` | streaming client-protocol parser and its limits |
| `src/subjects.ts` | subject validation and the `SubjectTrie` |
| `src/server.ts` | `Broker`: connections, delivery, liveness, errors, stats |
| `src/index.ts` | CLI, environment configuration, loopback guard, SIGINT/SIGTERM |
| `test/helpers.ts` | `Raw` hand-driven protocol client, `startBroker` |
