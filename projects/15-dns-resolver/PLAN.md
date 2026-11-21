# A6 -- Build your own DNS resolver: plan

Status (2026-11-21): stages 1-4 DONE. 82 tests (+9 opt-in: live root servers, live nslookup.exe); 41 mutation checks, 36 caught at first, 4 gaps closed with new tests, 1 equivalent mutant explained in README.md; 2 more gaps found by code reading and fixed (see README). Live test against the real roots passed once (6/6). Interview bank in interview/data/p15-dns-resolver/.

## Why this project

Every other project in this repo sits on top of DNS and never looks at it. This one does the whole job by hand: the
binary wire format, walking down from the root servers, following referrals and CNAMEs, caching with TTLs, and
answering ordinary tools (`nslookup`, `dig`) on loopback. It teaches binary parsing of untrusted input, a protocol that
runs over UDP with a TCP fallback, and the security thinking behind cache poisoning (Kaminsky, bailiwick).

## Decisions (one recommendation each)

- **TypeScript on Node 20, zero runtime dependencies.** `node:dgram` and `node:net` for sockets, `node:crypto` for
  random IDs and ports. `node:dns` is NOT used for resolution anywhere in `src/` -- doing it ourselves is the point. It
  appears only in the opt-in live test, as an independent check of our answers.
- **Names are strings without the trailing dot, root = "".** Label bytes that are not printable ASCII (and "." or "\"
  inside a label) use presentation escapes (`\.`, `\DDD`), so a label containing a dot is never confused with two
  labels. Comparison is ASCII case-insensitive and label by label (`isSubdomain`), never a plain `endsWith`.
- **Compression pointer rule: a pointer must point strictly before the labels being read, plus a cap of 32 pointers
  per name.** The first rule alone guarantees termination (targets strictly decrease); the cap bounds the work for a
  long backwards chain. Both are tested separately. Encoding compresses case-insensitively, so a repeated name comes
  back in the case of its first occurrence (written down, tested).
- **Unknown types (and OPT) are kept as raw rdata** (RFC 3597). Names inside unknown rdata are never decompressed or
  compressed.
- **Transport: IPv4 only.** The root hints carry the IPv6 addresses too, but the resolver only sends over IPv4 (many
  home and cloud networks have no IPv6 route; adding it is a NOT-done item).
- **Spoofing defences on every UDP query:** a fresh socket per query bound to a random port (picked with
  `crypto.randomInt`, not left to the OS), a random 16-bit ID, and a reply is only accepted if it comes from the
  address and port we sent to, has our ID, has QR set, and echoes our exact question. Anything else is ignored and we
  keep waiting until the timeout (an attacker's wrong guess must not end the query).
- **Bailiwick: a server answering for zone Z can only teach us records at or below Z.** Everything else in its
  response is dropped before the cache sees it. Glue is only used (and cached) if it is inside the zone of the server
  that sent it.
- **Tests never need the internet.** A fake network of in-process authoritative servers (UDP + TCP on the same
  ephemeral loopback port each) serves fixture zones. The fixture zones use documentation addresses (192.0.2.0/24,
  198.51.100.0/24, 203.0.113.0/24) and the resolver takes a `route` hook that maps such an address to the loopback
  port of the fake server. In production `route` is the identity with port 53. Reason: glue in a real referral only
  carries an IP, never a port, so the fake network needs a "routing table" from IP to socket, and this keeps the
  fixture zones looking like real zones. ONE opt-in live test (`LIVE_DNS=1`) talks to the real root servers.
- **Cache: positive RRsets keyed by (name, type), negative entries per RFC 2308** (NXDOMAIN for the name, NODATA for
  the name + type), TTL of a negative entry = min(SOA TTL, SOA minimum). A clock is injected so TTL tests do not sleep.
  Data learnt from referrals (NS, glue) is ranked lower than authoritative answers and never replaces them, and is not
  returned as an answer to a client.
- **Stub server binds 127.0.0.1 only** unless `ALLOW_NON_LOOPBACK=1` -- an open recursive resolver on the internet is
  used for DNS amplification attacks.

## Stages

| Stage | What | Proves it |
|---|---|---|
| 1 | Wire format: header, question, RR sections; name compression (decode with loop protection and bounds checks, encode with compression); A, AAAA, NS, CNAME, SOA, MX, TXT, PTR; unknown types raw | `test/wire.test.ts`: round trips, RFC 1035 4.1.4 example, pointer loops, chains, limits, truncation at every offset, 6000 random / bit-flipped packets |
| 2 | Iterative resolution from root hints: referrals, glue, out-of-bailiwick NS lookups, CNAME chains with a limit, NXDOMAIN / NODATA, TC -> TCP, timeouts and next server, random ID and port, bailiwick checks | `test/resolver.test.ts` against a fake network; transport tests for spoofed replies |
| 3 | Cache with TTLs and negative caching; UDP + TCP stub server on loopback; CLI | `test/cache.test.ts`, `test/server.test.ts`, `nslookup` interop, opt-in live test |
| 4 | Mutation checks, README, interview bank (100+ questions) | mutation table, validator `[OK]` |

## Not in scope

DNSSEC validation, EDNS(0) (we never send OPT; a query's OPT is ignored), DNS over TLS/HTTPS, zone transfers,
authoritative serving of real zones, IPv6 transport.

## Decisions changed or added while building (2026-11-21)

- **Interop with nslookup needs port 53.** The plan said `nslookup example.com 127.0.0.1 -port=N`. On this Windows
  build (10.0.26200) nslookup ignores `-port` and `set port`: listeners on 53 and N showed packets only on 53. So the
  always-on interop test uses packets captured from nslookup.exe, and the live nslookup run is opt-in
  (`INTEROP_NSLOOKUP=1`) and binds 127.0.0.1:53.
- **Live cross-check uses the OS resolver, not c-ares, by default.** `node:dns` c-ares chose 127.0.0.1 as its server
  here and got ECONNREFUSED. A records are compared with `dns.lookup` (getaddrinfo); the c-ares MX/NXDOMAIN checks run
  only with `LIVE_DNS_CHECK_SERVER=<ip>`.
- **Stage 3 was split from stage 2 differently than planned:** the cache class came with stage 2 (the resolver needs it
  for zone cuts and glue); its TTL and negative-caching tests came with stage 3.
