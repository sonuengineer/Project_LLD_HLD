# A6 -- DNS resolver, written by hand

A recursive DNS resolver in TypeScript on Node's `dgram` and `net` modules, with **zero runtime dependencies**.
`node:dns` is not used for resolution anywhere in `src/` -- it appears only in the opt-in live test, as an
independent check of our answers.

Status (2026-11-21): **stages 1-4 done** -- wire format, iterative resolution from the root servers, TTL cache with
negative caching, a stub server that `nslookup` talks to, mutation checks, and the interview bank. See PLAN.md.

```
nslookup / dig / OS stub          src/server.ts           src/resolver.ts + src/cache.ts       the internet
   query RD=1  ---- UDP/TCP ---->  DnsServer  ------------>  Resolver.resolve  ---- UDP, RD=0 ---->  root -> TLD -> zone
               <--- answer RA=1 -           <------------   (cache, CNAME chain)  <-- referral / answer / NXDOMAIN
                                                              src/transport.ts: random port + ID, TC -> TCP
                                                              src/wire.ts: every byte in and out
```

## Stage 1: wire format (`src/wire.ts`)

| Rule | Where | Proven by (`test/wire.test.ts`) |
|---|---|---|
| Header flags QR, opcode, AA, TC, RD, RA, rcode on the right bits | `readHeader`, `encodeMessage` | "header flags are on the right bits" |
| A, AAAA (RFC 5952 text), NS, CNAME, SOA, MX, TXT, PTR decoded and encoded; unknown types and OPT kept as raw rdata (RFC 3597) | `readRData`, `writeRData` | round-trip tests |
| Names: no trailing dot, root = "", `\.` and `\DDD` escapes so a label with a dot stays ONE label; compared ASCII case-insensitively and label by label | `nameToLabels`, `canonicalName`, `isSubdomain` | escape round trip, `isSubdomain("a\.example.test", "example.test")` is false |
| Compression on encode: the longest suffix already written becomes a pointer (case-insensitive, offsets < 0x4000 only) | `Writer.name` | "encoding compresses repeated suffixes" |
| Compression on decode, RFC 1035 4.1.4 example | `readName` | "decodes the RFC 1035 4.1.4 example" |
| Loop protection 1: a pointer must point strictly BEFORE the labels being read, so targets strictly decrease and decoding always ends | `readName` | self-pointer, A -> B -> A, forward pointer |
| Loop protection 2: at most 32 pointers per name (`MAX_POINTER_JUMPS`), which bounds the work of a long backwards chain | `readName` | chain of 32 accepted, 33 rejected |
| Name <= 255 bytes, label <= 63, reserved label types 0x40/0x80 rejected | `readName`, `nameToLabels` | limits tests |
| rdlength must match what the rdata really uses (A = 4, AAAA = 16, a name inside rdata stays inside it, no trailing bytes) | `readRData` | rdlength tests |
| Every read is bounds checked; malformed input throws `WireError`, nothing else; counts in the header never pre-size an array | `Reader` | truncation at every offset; 3000 random + 3000 bit-flipped packets |

One honest detail: compression is case-insensitive, so `WWW.EXAMPLE.TEST` written after `www.example.test` comes back
as `www.example.test`. DNS names are case-insensitive, so this is allowed, and the test says so.

## Stage 2: iterative resolution (`src/resolver.ts`, `src/transport.ts`, `src/root-hints.ts`)

`resolve(name, type)` follows the CNAME chain; for each link it checks the cache, finds the closest zone cut it already
knows servers for (or the root hints), and asks that zone's servers with RD=0 until it gets an answer, a CNAME, a
negative answer, or a referral one level down.

| Rule | Where | Proven by (`test/resolver.test.ts`, fake network) |
|---|---|---|
| Root hints embedded as data, with source and date (IANA `named.root`, "last update: November 12, 2026") | `src/root-hints.ts` | live test: `a.root-servers.net` resolves to the address in the hints |
| Referrals followed with in-bailiwick glue: root -> test -> alpha.test, 3 queries, RD=0 on every one | `classify`, `serversFor` | "follows root -> test -> alpha.test" |
| The next lookup in the same zone starts at the cached zone cut, not the root | `closestServers` | "a sibling name starts at the cached zone cut" (1 query) |
| Out-of-bailiwick NS without glue: the NS host is resolved first (nested lookup), then asked | `serversFor` | "out-of-bailiwick NS without glue" |
| CNAME chains followed across zones, at most `maxCnameChain` (8) links; a loop is SERVFAIL, not a hang | `resolveChain` | chain of 10 = SERVFAIL, 8 = OK, loop = SERVFAIL |
| NXDOMAIN and NODATA (incl. an empty non-terminal) returned with the zone's SOA; a CNAME to a missing name = NXDOMAIN with the CNAME | `classify` | NXDOMAIN / NODATA tests |
| TC=1 on UDP -> the same query to the same server over TCP (2-byte length prefix) | `exchange`, `queryTcp` | "a truncated (TC) UDP reply is retried over TCP" |
| Timeout, SERVFAIL, REFUSED, undecodable reply or a lame referral (pointing up or sideways) -> next server of the zone; all failed -> SERVFAIL | `askZone` | timeout, SERVFAIL/REFUSED, all-dead, lame, garbage tests |
| Limits: 60 upstream queries per resolution (nested lookups included), NS lookups nested at most 4 deep, 16 referrals | `askZone`, `serversFor` | delegation loop `loop1.test <-> loop2.test` = SERVFAIL; budget and depth tests |
| Spoofing: fresh socket per query on a RANDOM port (10000-65535, `crypto.randomInt`), random ID; a reply counts only from the exact address and port, with QR, our ID, our exact question. Anything else is ignored and we keep waiting | `queryUdp`, `matchesQuery` | wrong ID, wrong source port, wrong question, "IDs and source ports are random" |
| Bailiwick: a server for zone Z only teaches records at or below Z; glue only if inside the zone of the server that sent it | `classify` | poisoned extra answer/authority/additional not cached; out-of-zone glue ignored |

### Why random IDs and ports (spoofing and Kaminsky)

A resolver asks over UDP, and UDP has no handshake: anyone who can send a packet with our server's address as the
source can try to answer first. An off-path attacker cannot see our query, so he must GUESS what makes a reply
acceptable: the 16-bit ID, and the source port we sent from. With a fixed port only the ID is left: 65536 values.

The classic attack waits for a TTL to run out and then races. **Kaminsky (2008)** made it much worse: the attacker makes
the resolver look up random names that do not exist (`x1.bank.test`, `x2.bank.test`, ...). Each one is a fresh race
that no cache can stop, and his forged replies carry, besides the fake answer, a referral: "bank.test is served by
ns.bank.test at <attacker's address>", with glue. One win and the whole zone is his until the TTL ends.

What this resolver does against it:
- a random source port per query (about 55000 values) times a random ID (65536): about 3.6 billion combinations per
  query instead of 65536;
- the reply must come from the address and port we sent to and echo our exact question;
- a wrong reply is ignored, not fatal, so the attacker cannot even cause cheap failures;
- bailiwick: forged records outside the zone we asked are dropped, and referral data never overwrites an answer.

What it does NOT do (and what really closes the hole): DNSSEC validation. Random ports only make guessing expensive.
Also not done: 0x20 case randomisation, which would add more bits.

## Stage 3: cache and stub server (`src/cache.ts`, `src/server.ts`, `src/index.ts`)

| Rule | Where | Proven by |
|---|---|---|
| Whole RRsets cached under (name, type); TTL = smallest in the set, counted down on read; TTL 0 never cached; capped at `maxTtl` (1 day) | `Cache.putRRset`, `getRRset` | `test/cache.test.ts` with an injected clock |
| Negative caching (RFC 2308): NXDOMAIN per NAME (all types), NODATA per name + type, TTL = min(SOA TTL, SOA minimum), capped at 3 hours, not cached without an SOA | `putNegative`, `getNegative` | unit tests + "NXDOMAIN is cached for the SOA minimum (60 s) and covers other types" |
| Ranking: referral data (NS, glue) never overwrites an unexpired answer and is never returned as an answer | `Rank`, `putRRset` | unit test + "referral data is cached at low rank" |
| After the TTL, the answer is fetched again, but the long-lived zone cut is still used (1 query, no root) | resolver + cache | "an answer is re-fetched after its TTL" |
| Stub server on UDP and TCP, same port; ID and RD copied, RA=1, CNAME chain + answer, SOA for negatives | `DnsServer.handle` | `test/server.test.ts` |
| UDP answers over 512 bytes: TC=1, no records; the full answer over TCP (pipelined queries, split frames) | `handle`, `onTcp` | TC test, TCP pipelining test |
| Malformed body -> FORMERR with the same ID; less than a header -> dropped; QR=1 -> dropped (no ping-pong); other opcodes, classes, ANY, AXFR -> NOTIMP; 0 or 2 questions -> FORMERR; an EDNS OPT in the query is ignored | `handle` | server tests |
| Binds loopback only; anything else needs `ALLOW_NON_LOOPBACK=1` (an open resolver is an amplification weapon) | `listen`, `src/index.ts` | bind guard test |

## Interop with real tools (2026-11-21, Windows 11 build 10.0.26200)

- **nslookup.exe, captured packets (always run):** a plain UDP listener recorded what `nslookup www.alpha.test.
  127.0.0.1` sends: a PTR query for `1.0.0.127.in-addr.arpa` (to name the server), then A, then AAAA, all with RD=1 and
  no EDNS. The bytes are in `test/interop.test.ts`; our decoder parses them and the stub server answers each one.
- **nslookup.exe, live (opt-in `INTEROP_NSLOOKUP=1`):** runs nslookup against the stub server (resolving through the
  fake network): A, MX, NXDOMAIN, and `-vc` (TCP) for a TXT record too big for UDP. All pass.
- **Finding:** this nslookup build **ignores `-port=N`** (and `set port=N`). With listeners on both 53 and N, only 53
  ever received a packet. So `nslookup example.com 127.0.0.1 -port=5300` does not reach the server; start it with
  `PORT=53` for nslookup (on loopback, port 53 needed no admin rights here), or use `dig -p` where dig exists (not
  installed on this machine).
- **By hand, real internet:** `PORT=53 node dist/index.js`, then `nslookup example.com. 127.0.0.1` and
  `nslookup -type=MX gmail.com. 127.0.0.1` both answered through our resolver from the real root servers.

## Live test against the real root servers (opt-in `LIVE_DNS=1`)

Run once on 2026-11-21 from this machine: **6 of 6 passed** (with `LIVE_DNS_CHECK_SERVER` set to the machine's
configured DNS server; 5 passed + 1 skipped without it). It checks `a.root-servers.net` A/AAAA against our own hints
and the OS resolver, `example.com` A against the OS resolver (`dns.lookup`, getaddrinfo), a CNAME chain
(`www.wikipedia.org`), `gmail.com` MX against c-ares, and NXDOMAIN for `does-not-exist.invalid` straight from a root.

Two honest notes: Node's c-ares picked `127.0.0.1` as its server on this machine and got ECONNREFUSED, so the c-ares
cross-checks only run when `LIVE_DNS_CHECK_SERVER` names a resolver. And the `gmail.com` MX trace shows the bailiwick
rule at work on real data: Google's server sent 10 address records for `*.l.google.com` with the `gmail.com` answer, and
all 10 were dropped as out of bailiwick (they get resolved properly if someone asks for them).

A trace of a real lookup (`node dist/index.js resolve www.wikipedia.org`), shortened:

```
  d.root-servers.net (199.7.91.13) UDP www.wikipedia.org A: NOERROR
referral . -> org (v0n0.pir-ns.org, v0n1.pir-ns.org, ...)
  v0n3.pir-ns.org (...) UDP www.wikipedia.org A: NOERROR
referral org -> wikipedia.org (ns0.wikimedia.org, ns2.wikimedia.org, ns1.wikimedia.org)
  ns0.wikimedia.org (...) UDP www.wikipedia.org A: NOERROR          <- CNAME dyna.wikimedia.org
  v0n1.pir-ns.org (...) UDP dyna.wikimedia.org A: NOERROR           <- org NS is cached, root skipped
referral org -> wikimedia.org (...)
  ns0.wikimedia.org (...) UDP dyna.wikimedia.org A: NOERROR
;; NOERROR, 5 upstream queries
```

No timings are claimed: a handful of manual runs is not a measurement.

## Mutation checks (2026-11-21)

Each rule was broken on purpose (one exact text replacement in `src/`), the whole suite was run, and the file was
restored (`git status` clean afterwards). A check "passes" when at least one test turns red. W = wire format,
T = transport, R = resolver, C = cache, S = stub server. First run against the suite of 85 tests (76 run + 9 opt-in
skipped).

| # | Deliberate break | Tests failed |
|---|---|---|
| W1 | compression pointer may point forward (backwards-only rule removed) | 2 |
| W2 | no cap on pointers per name | 1 |
| W3 | no bounds check on the second byte of a pointer | **0 (not caught)** -> 1 with the new test |
| W4 | no bounds check on a label's bytes | **0 (not caught)** |
| W5 | no 255-byte limit on decoded names | 1 |
| W6 | A record rdlength not checked | 1 |
| W7 | rdata may use fewer/more bytes than rdlength | **0 (not caught)** -> 1 with the new test |
| W8 | encoder never compresses | 2 |
| W9 | Reader.need bounds check removed | 2 |
| T1 | reply ID not checked | 1 |
| T2 | reply source address/port not checked | 1 |
| T3 | echoed question not checked | 1 |
| T4 | fixed source port instead of a random one | 1 |
| T5 | fixed query ID | 1 |
| R1 | TC bit ignored (no TCP retry) | 3 |
| R2 | bailiwick filter off (every record believed) | 2 |
| R3 | CNAME chain limit raised to 1000 | 1 |
| R4 | a timeout fails the lookup instead of trying the next server | 3 |
| R5 | SERVFAIL/REFUSED from a server accepted as the answer | 1 |
| R6 | upward / sideways referral accepted (lame check off) | 1 |
| R7 | glue cached at answer rank | 1 |
| R8 | no per-resolution query budget | **0 (not caught)** -> 1 with the new test |
| R9 | no nesting limit for NS-address lookups | **0 (not caught)** -> 1 with the new test |
| R10 | queries sent with RD=1 | 1 |
| R11 | cached CNAME not followed (always asks upstream) | 1 |
| C1 | positive entries never expire | 3 |
| C2 | RRset TTL taken from the first record, not the smallest | 1 |
| C3 | negative TTL ignores the SOA minimum | 2 |
| C4 | NXDOMAIN cached per type instead of per name | 2 |
| C5 | referral data may overwrite an unexpired answer | 1 |
| C6 | referral data returned as an answer | 2 |
| C7 | TTL 0 records cached | 1 |
| C8 | no maxTtl cap | 1 |
| C9 | negative entries never expire | 2 |
| C10 | negative answer without SOA cached anyway (with a default TTL) | 1 |
| S1 | non-loopback bind allowed | 1 |
| S2 | big UDP answers not truncated | 2 |
| S3 | packets with QR=1 answered | 1 |
| S4 | malformed query dropped instead of FORMERR | 1 |
| S5 | reply ID not copied from the query | 4 |
| S6 | ANY/AXFR passed to the resolver | 1 |

**41 checks: 36 caught on the first run, 5 not.** What was done about the 5:

- **W3, W7, R8, R9 were real gaps**, and each now has its own test (re-run against the 89-test suite: each is caught by
  exactly the new test).
  - W3: the "half a pointer" tests still threw a WireError, but from a LATER check (the question's type field), so the
    pointer guard itself was untested. New test calls `readName` directly on `[0, 0xc0]`.
  - W7: no test had rdata with bytes left over after a name; without the check, the decoder would start reading the
    next record in the middle of the previous one's rdata. New test: an NS record with 2 junk bytes.
  - R8 / R9: the delegation-loop test is stopped by EITHER the query budget or the nesting limit, so removing one alone
    changed nothing. New tests pin each limit on its own (`maxQueries: 2`, `maxDepth: 0`).
- **W4 is not caught, and cannot be by any behaviour test:** without the label bounds check, the label is cut short,
  `pos` jumps past the end, and the loop's very next check ("name runs past the end") throws the same WireError. It is
  an equivalent mutant; the check stays because it gives the right error message.

W8 also made `tsc` fail (an unused variable), but the tests were run anyway and 2 failed. After restoring: 80/80 pass
(plus 9 opt-in skipped), and 3 repeated full runs gave the same result.

**Two more gaps, found later by reading the code while writing the interview bank** (not by a mutation):
- `classify` has a branch for a server that sends rcode NXDOMAIN together with a CNAME (the alias exists, its target
  does not). The fake server always sends NOERROR for a CNAME, so no test reached that branch. New test: a hook makes
  the server send NXDOMAIN, and the chain is still followed.
- The stub server called `handle()` from the socket callbacks with no `.catch`: an unexpected exception (a bug, not a
  ResolveError) would have become an unhandled rejection, which ends a Node process by default. Now an exception from
  the resolver becomes SERVFAIL (tested with a resolver that throws), and any other rejection only counts as `dropped`.

Suite now: 82 tests + 9 opt-in.

## NOT implemented yet (honest list)

- **DNSSEC validation.** The real fix for spoofing; record types like DS/RRSIG decode as raw rdata.
- **EDNS(0).** We never send OPT, so upstream UDP replies are limited to 512 bytes and more answers fall back to TCP;
  the stub server ignores a client's OPT and also caps UDP at 512.
- **IPv6 transport.** The hints carry IPv6 addresses but the resolver sends over IPv4 only; AAAA glue is not used.
- **Server selection by RTT, remembering lame/dead servers.** Servers of a zone are tried in random order every time;
  a dead server costs a full timeout on every lookup that picks it first.
- **No in-flight deduplication:** two identical concurrent queries both go upstream.
- **No root priming** (asking a root for the current `.` NS set at start-up) and no QNAME minimisation (RFC 9156): every
  server along the path sees the full name.
- **No 0x20 case randomisation** (extra spoofing entropy).
- **Stub server:** no rate limiting, no access control beyond the loopback guard, no max concurrent queries, no cache of
  whole responses.
- **Cache:** eviction is "oldest first" by insertion, not LRU; no serve-stale (RFC 8767); no prefetch.
- **CNAME + NXDOMAIN from a non-final zone,** DNAME (RFC 6672) and wildcard synthesis are not specially handled (a
  DNAME decodes as raw rdata and is ignored).
- **Glue for an NS host that is a CNAME** and other broken-zone workarounds that big resolvers carry are not there.

## Run it

```
npm install
npm test                          # 82 tests (+9 opt-in); fake network only, no internet needed
INTEROP_NSLOOKUP=1 npm test       # also run Windows nslookup.exe against the stub server on 127.0.0.1:53
LIVE_DNS=1 npm test               # also resolve real names from the real root servers (needs outbound UDP/TCP 53)
npm run build
node dist/index.js resolve www.wikipedia.org A    # one lookup from the root, every step printed
npm start                         # stub server on 127.0.0.1:5300 (UDP + TCP)
```

PowerShell: `$env:PORT=53; npm start`, then `nslookup example.com. 127.0.0.1`. Settings (environment variables):
`HOST` (default `127.0.0.1`), `PORT` (5300), `TIMEOUT_MS` (2000), `TRACE=1` (print every upstream query),
`ALLOW_NON_LOOPBACK=1` (needed for any non-loopback address; never a public one).

## Files

| File | Purpose |
|---|---|
| `src/wire.ts` | message types, encode/decode, name compression, name helpers |
| `src/transport.ts` | one query over UDP (spoofing checks) or TCP (length prefix); TCP framing |
| `src/root-hints.ts` | the 13 root servers, with source and date |
| `src/resolver.ts` | iterative resolution: referrals, glue, CNAME, negative answers, next server, limits, bailiwick |
| `src/cache.ts` | RRset and negative cache with TTLs and ranking |
| `src/server.ts` | stub server, UDP + TCP, loopback guard |
| `src/index.ts` | CLI: serve, or `resolve <name> [type]` with a trace |
| `test/fakenet.ts` | fake authoritative servers with hooks for misbehaviour and a query log |
| `test/fixtures.ts` | the fixture zone tree (root, test, example, alpha.test, beta.test, loops, lame) |
