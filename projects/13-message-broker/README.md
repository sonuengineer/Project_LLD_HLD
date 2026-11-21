# H12 -- NATS-style message broker

A hand-written pub/sub message broker in TypeScript on Node's `net` module, with **zero runtime dependencies**. It speaks
the core NATS client protocol, so the official `nats` client library connects to it unchanged.

Status (2026-11-21): **stage 1 of 5 done** -- a single server. Clustering, queue groups and the measurements come in
later stages (see [PLAN.md](PLAN.md)). Nothing has been measured or deployed yet, so this README contains no performance
numbers.

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

All 12 caught. After restoring: 88/88 pass (also 5 repeated full runs, 88/88 each).

## NOT implemented yet (honest list)

- **Queue groups** (`SUB subject group sid`): the server answers `-ERR 'Queue Groups Not Supported Yet'`. Stage 2.
- **Headers** (`HPUB`/`HMSG`): INFO says `headers: false`; `HPUB` is an unknown operation. Stage 2.
- **Slow-consumer protection**: a subscriber that stops reading lets its socket write buffer grow without a bound. This
  is the most important gap; stage 2 adds a per-client pending-bytes limit.
- **Graceful drain on shutdown**: `close()` drops connections. Stage 2.
- Clustering (stage 3), authentication, TLS, persistence, accounts, max connections, `pedantic` mode.
- Operations are accepted before `CONNECT` (nats-server only insists when auth is on; there is no auth here).
- A repeated `sid` on SUB is ignored (the first subscription stays).

## Run it

```
npm install
npm test            # 88 tests: parser, trie, raw TCP integration, official-client interop
npm run build
npm start           # listens on 127.0.0.1:4222
```

PowerShell: `$env:PORT=4333; npm start`. Settings (environment variables): `HOST` (default `127.0.0.1`), `PORT` (4222),
`MAX_PAYLOAD` (1048576), `PING_INTERVAL_MS` (120000), `MAX_PINGS_OUT` (2). There is **no authentication**, so binding
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
