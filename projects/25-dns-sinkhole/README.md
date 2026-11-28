# 25 -- DNS sinkhole: build your own ad/tracker blocker

A Pi-hole-style DNS proxy in TypeScript, **zero runtime dependencies**: it answers blocklisted domains itself
(NXDOMAIN or a sinkhole IP, your choice) and forwards everything else to a real upstream resolver, caching the
answer for as long as its TTL says it is good for. It replaces a paid ad blocker with something you can read start
to finish in one sitting.

Status (2026-11-28): **Stage 1 done** -- wire format, trie blocklist, both block modes, UDP-with-TCP-fallback
forwarding, TTL cache, a real UDP server, mutation checks. See PLAN.md for the design decisions.

```
browser / OS stub resolver         src/server.ts            src/proxy.ts                     src/transport.ts
  query  ---- UDP ---------------->  SinkholeServer  ------->  SinkholeProxy.handle  --------->  forwardQuery
         <--- answer or NXDOMAIN -                <---------  (blocklist? cache? forward?)  <--  UDP, TC->TCP
                                                     |                                             |
                                            src/blocklist.ts                              configured upstream
                                            src/cache.ts (TTL, lazy expiry)              (e.g. 1.1.1.1, or a test stub)
```

## Run it

```
npm install
npm test          # 89 tests, no internet needed -- the "upstream" in every test is a stub server we control
npm run typecheck
npm run demo       # starts a stub upstream + the proxy, shows a block, a forward, and a cache hit
```

To actually run it against the real internet (outside the scope of Stage 1's test suite, but the pieces are all
there): point `SinkholeProxyOptions.upstream` at a real resolver (e.g. `{ host: "1.1.1.1", port: 53 }`), load a
real blocklist with `loadBlockListFile("config/blocklist.txt")`, and bind `SinkholeServer` to a port your OS or
router will actually query (53 needs admin/root; this project defaults to the high port 15353 so nothing above
needs elevated privileges).

```ts
import { BlockList, SinkholeProxy, SinkholeServer, loadBlockListFile } from "./src/index.js";

const proxy = new SinkholeProxy({
  blockList: new BlockList(loadBlockListFile("config/blocklist.txt")),
  mode: "sinkhole", // or "nxdomain"
  sinkholeAddress: "0.0.0.0",
  upstream: { host: "1.1.1.1", port: 53 },
});
const server = new SinkholeServer({ proxy, port: 15353 });
await server.listen();
```

## The rules

- A blocklist line blocks that **exact domain and every subdomain of it** (`ads.example.com` also blocks
  `tracker.ads.example.com`), never the other way around (blocking `ads.example.com` does NOT block
  `example.com`). Blank lines and lines starting with `#` or `;` are comments.
- A blocked query is answered **immediately, without ever contacting upstream** -- in `"nxdomain"` mode with
  NXDOMAIN, in `"sinkhole"` mode with a configured A record (default `0.0.0.0`) for an A query, and NXDOMAIN for
  every other query type in BOTH modes (AAAA sinkholing is not implemented -- see PLAN.md).
- A non-blocked query is forwarded to upstream over UDP; if the reply is truncated (TC=1), the SAME query is
  retried over TCP and that answer is used instead. The client always gets the full, non-truncated answer.
- A successful (NOERROR, at least one answer record) upstream reply is cached under its exact (name, query type)
  for the SMALLEST TTL among its answers. A repeated query for the same (name, type) within that window is
  answered from cache, never touching upstream again; the TTL handed back is counted down by elapsed time, same
  as a real resolver's cache. An expired entry is simply treated as a miss and re-fetched -- there is no
  background sweep (see PLAN.md).
- Upstream not answering (or erroring) within its timeout returns SERVFAIL to the client -- promptly, never a
  hang, never an exception that kills the process. An upstream reply with a transaction ID or QR bit that does
  not match the query sent is treated the same way (SERVFAIL), not relayed.
- A query this proxy cannot make sense of gets the closest real-DNS answer: fewer than 12 bytes (no header) is
  dropped silently; a non-QUERY opcode or non-IN class is NOTIMP; zero or more than one question is FORMERR; a
  packet with QR=1 (a response, not a query) is dropped so two servers sent each other's output can never
  ping-pong.
- The server binds loopback only, unless `allowNonLoopback` is explicitly set -- same reasoning as
  `15-dns-resolver`'s stub server: an open resolver with no access control is a DNS amplification tool.

## Design choices

See PLAN.md for the full reasoning (relay-raw-bytes vs. re-encode, trie vs. Set, NXDOMAIN vs. sinkhole IP, lazy
expiry vs. a background sweep, the threat-model difference from `15-dns-resolver`). The short version: this
project decodes only as much of the DNS wire format as it needs to make a decision (a question, and an upstream
answer's name/type/class/ttl), and relays everything it does not understand as the exact bytes the upstream sent
-- which is also what makes it safe to not implement a full RR type zoo.

## Stage 1: wire format (`src/wire.ts`)

| Rule | Where | Proven by (`test/wire.test.ts`, 24 tests) |
|---|---|---|
| Header flags, a query's exact id/rd round-trip through encode/decode | `decodeQuery`/`encodeMessage` | round-trip tests |
| Names: latin1 (every byte round-trips), root = `""`, no trailing dot | `canonicalName`, `nameToLabels` | "lowercases and strips one trailing dot" |
| Label <= 63 bytes, name <= 255 wire bytes, both on decode AND encode | `nameToLabels`, `readName` | limits tests |
| Compression pointers decoded; must point strictly BEFORE the current labels (so targets strictly decrease and decoding always ends); at most `MAX_POINTER_JUMPS` (32) per name | `readName` | 1-jump, 32-jump, 33-jump (rejected), self/forward pointer (rejected) |
| Reserved label-length bits (0x40/0x80) rejected -- checked directly, not as a side effect of a bounds check | `readName` | "...even when enough bytes follow to NOT look truncated" |
| Every read is bounds-checked; a truncated or garbage packet throws `WireError`, nothing else | `Reader` | truncation tests; 1500 random + 500 bit-flipped packets across 5 seeds |
| An upstream answer's TTL is read (and its byte OFFSET recorded, for the cache) WITHOUT decoding its rdata -- only `rdlength` bytes are skipped | `decodeResponse` | "reads a compressed answer name..., skipping rdata untouched" |
| `encodeARecord` builds a real A record; rejects a non-IPv4 address | `encodeARecord` | round-trip + rejection tests |

## Stage 1: blocklist (`src/blocklist.ts`)

| Rule | Where | Proven by (`test/blocklist.test.ts`, 14 tests) |
|---|---|---|
| Exact domain blocked; every subdomain blocked; parent/sibling/lookalike NOT blocked | `isBlocked` | the core block-matching tests |
| Case-insensitive, one trailing dot ignored | `labelsOf` | case/dot test |
| A shorter listed domain's subtree covers a longer one added later, independent of insertion order | `add` | "a shorter listed domain blocks a longer query..." |
| Empty domain / empty label rejected at `add()` time, not silently ignored | `labelsOf` | rejection tests |
| `parseBlockListText`: comments (`#`, `;`) and blank lines skipped, CRLF handled | `parseBlockListText` | parsing tests |
| `loadBlockListFile` reads a real file end to end into a working `BlockList` | `loadBlockListFile` | reads `config/blocklist.txt` |

## Stage 1: cache (`src/cache.ts`)

| Rule | Where | Proven by (`test/cache.test.ts`, 11 tests, `ManualClock` throughout -- no real sleeps) |
|---|---|---|
| Stored under (name, type); returned until its TTL elapses, gone (and STAYS gone) the instant it does | `put`, `get` | TTL boundary + lazy-eviction-stays-evicted tests |
| `ttlSeconds <= 0` is never cached | `put` | rejection test |
| `put`/`get` both copy their buffer; the caller mutating either one never corrupts the cache | `put`, `get` | "mutating the buffer... does not corrupt the cache" (both directions) |
| Re-storing a key replaces its old TTL outright (no averaging, no "whichever is later") | `put` | "re-storing the same key replaces the old entry and its TTL" |
| `maxEntries` exceeded evicts the OLDEST entry first | `evict` | eviction test |
| Each `ttlOffsets` entry is counted down by elapsed time on every `get()`, floored at zero | `get` | countdown test, including right at the edge of expiry |

## Stage 1: upstream forwarding (`src/transport.ts`)

| Rule | Where | Proven by (`test/transport.test.ts`, 3 tests) |
|---|---|---|
| A successful UDP round trip resolves with the reply | `forwardQuery` | basic success test |
| No reply within the timeout rejects with `TimeoutError`, never hangs | `queryUdp` | timeout test |
| A reply from an address/port OTHER than the configured upstream is ignored, even if it arrives first | `queryUdp` | "ignores a reply from a different address/port..." (a rogue socket races the real upstream) |
| TC=1 on UDP retries the SAME query over TCP | `forwardQuery` | covered end to end in `proxy.test.ts` and `server.test.ts` (see below) |

## Stage 1: the proxy (`src/proxy.ts`) and server (`src/server.ts`)

| Rule | Where | Proven by |
|---|---|---|
| Blocked (exact or subdomain) never reaches upstream; non-blocked is forwarded, reply relayed with the CLIENT's exact transaction id | `handle` | `proxy.test.ts` "blocking" (4 tests) |
| Both block modes behave as configured; sinkhole address is the CONFIGURED one, not hardcoded; non-A types get NXDOMAIN in sinkhole mode too | `buildBlockResponse` | `proxy.test.ts` "block modes" (4 tests) |
| Cache hit never re-calls upstream (asserted via the stub's call count); a hit still carries the NEW request's own id and a counted-down TTL; different query types cache independently; NXDOMAIN (no answers) is relayed but never cached | `handle` | `proxy.test.ts` "caching" (6 tests) + the dedicated TTL-countdown test |
| After the TTL elapses (`ManualClock.advance`), the next query calls upstream again | `handle` + `ResponseCache` | `proxy.test.ts` "after the TTL elapses..." |
| TC=1 from upstream retries over TCP; the TCP-retrieved answer is still cached once, correctly | `handle` | `proxy.test.ts` "TCP fallback" (2 tests) |
| Upstream timeout/drop/unreachable -> SERVFAIL, promptly, never cached; a reply with a mismatched id/QR -> SERVFAIL, never relayed | `handle` | `proxy.test.ts` "upstream failure" (4 tests) |
| Malformed/unusual queries get the closest real-DNS answer (dropped, FORMERR, or NOTIMP as appropriate) | `handle` | `proxy.test.ts` "malformed and unusual queries" (5 tests) |
| `stats` counts blocked/cacheHits/forwarded/servfail correctly | `handle` | `proxy.test.ts` "stats" |
| The SAME behaviour holds end to end over a REAL UDP socket (not just calling `handle()` directly); server binds a high port (15353), never 53; refuses a non-loopback bind without `allowNonLoopback` | `SinkholeServer` | `test/server.test.ts`, 6 tests |

## Randomized invariant (`test/invariant.test.ts`, 5 seeds)

A 400-query random mix of blocked and allowed domains, with the clock jumping forward by random amounts, checked
against a hand-tracked shadow model (which names SHOULD be cached and when they expire) rather than a second
implementation -- there is nothing else to compare against here. Invariant: a blocked query never increments the
upstream call count; an allowed query increments it exactly when the shadow model says the cache entry is
missing or expired, never otherwise; every reply (blocked or not) echoes the exact transaction id it was asked
with.

## Mutation checks (2026-11-28)

Each rule below was broken on purpose (one exact text replacement in `src/`), the whole suite was run, and the
file was restored byte-for-byte (verified by re-reading it) before moving to the next one -- none of this was
committed. First pass against the 88-test suite that existed at that point.

| # | Deliberate break | Result |
|---|---|---|
| WIRE1 | `readName`: backward-only compression-pointer rule disabled | caught |
| WIRE2 | `readName`: `MAX_POINTER_JUMPS` cap effectively removed | caught |
| WIRE3 | `nameToLabels`: 63-byte label limit removed | caught |
| WIRE4 | `encodeName`: 255-byte name limit removed | caught |
| WIRE5 | `readName`: reserved label-type (0x40/0x80) check removed | **not caught** -> closed |
| WIRE6 | `canonicalName`: lowercasing removed | caught |
| WIRE7 | `readName`: label-truncation bounds check removed | caught |
| BLOCK1 | `BlockList.isBlocked`: only the exact final node checked (subdomains no longer blocked) | caught |
| BLOCK2 | `labelsOf`: trailing-dot stripping removed | caught |
| BLOCK3 | `labelsOf`: lowercasing removed | caught |
| CACHE1 | `ResponseCache.put`: `ttlSeconds <= 0` guard removed | caught |
| CACHE2 | `ResponseCache.get`: expiry check disabled (entries never expire) | caught |
| CACHE3 | `ResponseCache`: `maxEntries` eviction disabled | caught |
| CACHE4 | `ResponseCache.get`: TTL countdown removed (always returns the original TTL) | caught |
| TRANSPORT1 | `queryUdp`: wrong-source address/port check removed | **not caught** -> closed |
| TRANSPORT2 | `forwardQuery`: TC bit ignored, never retries over TCP | caught |
| PROXY1 | `handle`: blocklist check skipped entirely | caught |
| PROXY2 | `handle`: cache-hit path disabled, always forwards | caught |
| PROXY3 | `handle`: upstream reply id/QR verification removed | **not caught** -> closed |
| PROXY4 | `handle`: non-QUERY opcode check removed | caught |
| PROXY5 | `handle`: nothing is ever cached after a successful forward | caught |
| PROXY6 | `buildBlockResponse`: nxdomain-mode / non-A-type guard removed | caught |
| SERVER1 | `SinkholeServer.listen`: loopback guard removed | caught |

**23 checks: 20 caught on the first run, 3 real gaps.** All three were closed, and a second mutation pass over
each confirmed it is now caught:

- **WIRE5**: the existing test only threw a 0x40/0x80 buffer with too few trailing bytes, so removing the
  reserved-type check still got caught by the UNRELATED truncation check right after it -- the guard itself was
  never actually exercised. New test: a 0x40 label with 64 real bytes following it (so no bounds check would ever
  fire); only the reserved-type check can reject it.
- **TRANSPORT1**: every test's "upstream" was the only thing that ever replied, so the wrong-source check had
  nothing to filter. Closing this honestly needed a way to prove a DIFFERENT sender's packet is ignored, which
  meant learning our own ephemeral UDP source port from outside the module -- added `ForwardOptions.onUdpBound`
  (test-only), fired right after bind, before the real query is even sent. New test: a rogue socket uses that hook
  to fire a fully-formed, DIFFERENT spoofed answer at our socket before the real upstream has even seen the
  query, and the real answer still wins.
- **PROXY3**: the stub upstream was always well-behaved (correct id, QR=1), so the id/QR check was never the
  thing standing between "right answer" and "wrong answer" in any existing test. New stub behavior,
  `"wrong-id"` (a confused/buggy upstream that answers with `(id + 1) & 0xffff`), plus a test asserting the
  client gets SERVFAIL with ITS OWN id, never the mismatched answer.

## Known and NOT handled

See PLAN.md's "Not in scope" for the full list and reasoning. In short: AAAA/other-type sinkholing (NXDOMAIN only
for those, in both modes), no DNS presentation escapes (a literal "." byte inside a label is not supported --
real hostnames never have one), no downstream TCP (clients only reach this proxy over UDP; TCP is only ever used
when WE talk to upstream), no anti-spoofing defence against the upstream beyond a source-address check (see
PLAN.md's threat-model decision), no negative caching (an NXDOMAIN from upstream is relayed but never cached), no
config hot-reload / multiple blocklists / allowlist exceptions / query log, no rate limiting on the proxy's own
listener beyond the loopback-only bind guard.

## Files

| File | Purpose |
|---|---|
| `src/wire.ts` | header + question decode, minimal answer-TTL decode (rdata skipped), small-message encode |
| `src/blocklist.ts` | trie-based `BlockList`, plain-text blocklist parsing/loading |
| `src/cache.ts` | raw-bytes `ResponseCache` with TTL expiry (lazy) and TTL countdown on read |
| `src/clock.ts` | injectable `Clock` (`systemClock` / `ManualClock`), same shape as `22-messaging` |
| `src/transport.ts` | one forwarded query to upstream: UDP with a timeout, TC -> TCP retry |
| `src/proxy.ts` | `SinkholeProxy`: the decision logic (block / cache hit / forward), pure buffer in, buffer out |
| `src/server.ts` | `SinkholeServer`: the real UDP listener clients talk to |
| `src/stub-upstream.ts` | a fully controllable fake upstream (used by tests AND the demo) |
| `src/demo.ts` | `npm run demo`: a block, a forward, a cache hit, and a TC -> TCP retry, end to end |
| `config/blocklist.txt` | a small illustrative blocklist (not a real curated list) |
