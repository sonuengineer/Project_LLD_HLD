# 25 -- DNS sinkhole (ad/tracker blocker): plan

Status (2026-11-28): Stage 1 DONE. 89 tests; 23 mutation checks, 20 caught at first, 3 real gaps found and closed
with new tests (re-run: all 23 caught). See README.md for the full test and mutation tables.

## Why this project

The owner found a paid ad/tracker blocker (Surfshark Adblock) in a Black Friday deals list and realized it is
doing something this repo already half-builds: `15-dns-resolver` parses and forwards DNS. A Pi-hole-style blocker
is the same wire format and the same UDP/TCP transport, aimed at a different job -- not resolving names from the
root down, but relaying everything EXCEPT a blocklist, which it answers itself. It is a natural, small extension
of a project already in this repo, and a good vehicle for the one new idea Stage 1 is really about: caching with
real TTL semantics on top of a proxy that does not fully understand the protocol it is relaying.

## Decisions (one recommendation each)

- **TypeScript on Node 20, zero runtime dependencies**, same toolchain as every other project here. `node:dgram`
  and `node:net` for sockets, same as `15-dns-resolver`. This is a fresh, self-contained implementation -- it does
  not depend on the `15-dns-resolver` package, though it reuses several of that project's PROVEN ideas (the wire
  format basics, the TC-bit-to-TCP retry pattern, the stub-server-on-a-high-port test setup) because those ideas
  are already right, not because the code is shared.

- **Relay forwarded answers as raw bytes; never re-encode them.** This is the single biggest design decision, and
  it is NOT the same choice `15-dns-resolver` makes (that project fully decodes every record type it understands
  and re-encodes a fresh answer for its own stub clients). This proxy only decodes what it needs to make a
  decision (the header, the question, and -- for an upstream's reply -- each answer's name/type/class/ttl, with
  rdata skipped by its length, never interpreted). The reason: an rdata field for a type we do not decode
  (CNAME, NS, MX, SOA, PTR, ...) can itself contain a DNS-compressed name, and a compression pointer is only valid
  relative to the EXACT bytes of the packet it was written into. If we rebuilt a new packet (different header
  bytes, maybe a different question encoding) and copied that rdata in unchanged, any pointer inside it could end
  up pointing at the wrong offset -- silent, hard-to-notice corruption. Relaying the exact upstream bytes (with
  only the 2-byte transaction ID patched for cache hits, and TTL fields decremented in place -- see below, both
  fixed-width integer fields, never touching a name or a pointer) sidesteps this entirely, and happens to make the
  whole project much smaller: there is no need for A/AAAA/NS/CNAME/SOA/MX/TXT/PTR encoders, only a decoder of
  "enough" (see wire.ts's file header for the exact scope cut).

- **Blocklist: a trie over reversed dot-labels, not a Set of domain strings.** Both give the "exact name or any
  subdomain" rule; the question is how cheaply. A Set would need one lookup per ANCESTOR of the query name --
  `isBlocked("x.y.ads.example.com")` builds and hashes `"x.y.ads.example.com"`, then (on a miss) `"y.ads.example.
  com"`, then `"ads.example.com"`, ... -- a fresh string allocation and hash per level, with zero sharing between
  entries even when thousands of them are subdomains of the same tracker domain. The trie walks the query's own
  labels ONE time, one map lookup per label, and every entry that shares a suffix (a real blocklist has huge
  numbers of these -- a thousand subdomains of `doubleclick.net` all share one `net -> doubleclick` path) shares
  the same nodes instead of paying for its own copy of that suffix. Recommended because it is cheaper on exactly
  the input shape (large lists, shared suffixes, deep subdomains) that a real ad/tracker list has.

- **Block response modes: NXDOMAIN or a sinkhole IP (0.0.0.0 default), configurable.** This is Pi-hole's own real
  design debate, not a dressed-up non-choice: NXDOMAIN is the technically correct answer ("this name does not
  exist"), but some client software retries aggressively on NXDOMAIN (treating it as "try again," not "give up"),
  which can turn one blocked ad request into a burst of retries. A sinkhole A record is a lie (the name DOES
  resolve, just to nothing useful), but most clients treat a normal-looking answer as final and do not retry. Pi-
  hole actually ships both as configurable options for exactly this reason, and so does this project -- there is
  no single right answer, which is why it is a setting, not a hardcoded choice. **Sinkholing is only implemented
  for A queries** (see "Not in scope"); every other query type gets NXDOMAIN in both modes.

- **Cache: lazy expiry, no background sweep timer.** Same reasoning this repo already uses for
  `23-password-manager`'s session idle timeout: a sweep needs a timer that runs independently of any request,
  with its own lifecycle (who starts it, who stops it, what clock does it read when nothing is asking a question
  right now) -- real design and testing cost for a benefit this specific cache does not need. An expired entry
  is simply treated as a miss and dropped the next time anything asks for that exact (name, type) again; nothing
  is lost by leaving it in memory a little longer than strictly necessary, and `maxEntries` (oldest-insertion
  evicted first, same technique as `15-dns-resolver`'s cache) bounds the one real risk (an expired-and-never-
  looked-up-again entry sitting there forever).

- **Cached entries are stored as raw bytes PLUS the byte offsets of each answer's TTL field**, so a cache hit can
  hand back TTLs counted down by elapsed time (a client asking 10 seconds into a 300-second TTL gets told 290,
  not a stale 300) -- real resolver behaviour, not just "cache the bytes and reuse them unchanged." This is safe
  specifically because a TTL field is a plain, fixed-position 4-byte integer with no name compression anywhere
  near it, unlike the rdata this project deliberately never touches (see the relay decision above).

- **The ID forwarded to upstream is the client's own, unchanged; concurrent client requests each get their own
  ephemeral socket.** A long-lived resolver socket (like `15-dns-resolver`'s, which serves MANY concurrent
  lookups through shared infrastructure) needs to rewrite IDs to multiplex safely. Here, every forwarded query
  gets a fresh UDP socket that talks to exactly one upstream query and then closes, so there is nothing to
  multiplex and rewriting the ID would only add work for no benefit.

- **Threat model: the upstream is ONE configured, trusted resolver (like 1.1.1.1 for Pi-hole), not the open
  internet's root server swarm.** `15-dns-resolver`'s iterative resolver talks to arbitrary authoritative servers
  it has never talked to before and must defend every UDP query with a random source port AND a random ID
  (Kaminsky-style spoofing defence, documented at length in that project's README). This proxy only ever
  round-trips with the one upstream address it was configured with, the same role 1.1.1.1 or 8.8.8.8 plays for
  Pi-hole -- a genuinely different, narrower threat model, so that defence is not reproduced here. One cheap check
  IS kept (a reply must come from the configured upstream's exact address and port, or it is ignored and we keep
  waiting) because it costs nothing and is still worth having; the ID/QR match on the DECODED reply is checked one
  layer up, in the proxy, and a mismatch there is a SERVFAIL, not a relayed wrong answer.

- **Downstream (client-facing) transport is UDP only; no TCP listener for clients.** The TC-bit-to-TCP-retry
  pattern IS implemented, as required, on the UPSTREAM side (if the upstream truncates its reply, we retry over
  TCP and relay the full answer back over UDP to the client). A downstream client that itself needs to retry over
  TCP against OUR server is not supported -- see "Not in scope." For ad/tracker blocking the answers involved are
  always small (an A record or an empty NXDOMAIN), so this is a low-cost cut, not a risky one.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Wire format (header + question decode, minimal answer-TTL decode, small answers we build ourselves); trie blocklist with wildcard subdomains; two block-response modes; UDP-with-TCP-fallback upstream forwarding; TTL cache with lazy expiry and TTL countdown; a real UDP stub server; mutation checks | DONE 2026-11-28 |
| 2+ | Not scoped. Candidates if ever picked up: multiple blocklists with precedence/allowlisting, a stats/query-log view, EDNS(0) passthrough, IPv6 (AAAA sinkhole), TCP on the client-facing side, config reload without a restart | not started |

## Not in scope

- **AAAA (and every other record type) sinkholing.** Sinkhole mode answers A queries with a configured IPv4
  address; everything else (AAAA, MX, TXT, ...) gets NXDOMAIN in both modes. A real IPv6 sinkhole (`::`) would be
  a small, mechanical addition but was not needed to prove the design.
  Note: this is not Pi-hole's own historical default (which until relatively recently answered AAAA queries for a
  blocked domain with NXDOMAIN regardless of mode) -- we picked the simpler of the two defensible options.
- **No DNS presentation escapes (`\DDD`, `\.`).** A label is kept as a latin1 string (every byte round-trips
  exactly), but a label containing a literal "." byte would be mis-split if re-encoded. Real DNS hostnames never
  do this.
- **No full RR decoding.** Only A/AAAA-shaped rdata is ever BUILT by this project (sinkhole answers); an upstream
  answer's rdata (of any type) is only ever skipped by its length, never interpreted -- see the relay decision
  above for why this is deliberate, not a missing feature.
- **No downstream TCP.** Clients only reach this proxy over UDP (see "Downstream transport" decision above).
- **No anti-spoofing defence against the upstream beyond a source-address check** (no random source port, no
  random query ID baked separately from the client's own). See the threat-model decision above.
- **No negative caching.** An NXDOMAIN or NODATA from upstream (zero answer records) is relayed to the client but
  never cached -- the next identical query asks upstream again. `15-dns-resolver` does implement RFC 2308 negative
  caching (via the response's SOA record); adding it here would be the same idea, not a new design problem, and
  was left out to keep Stage 1 focused on the proxy/cache interaction that is new to this project. One consequence
  worth naming: `proxy.ts` only computes a TTL (`Math.min(...parsed.answers.map(a => a.ttl))`) when
  `parsed.answers.length > 0`. `Math.min()` called with no arguments returns `Infinity` rather than throwing, so
  skipping that guard would not have crashed -- it would have silently cached a zero-answer response as if it had
  an effectively infinite TTL. The guard is there specifically because "no answers" and "nothing to cache" are the
  same condition, not two things to remember separately.
- **No config hot-reload, no multiple blocklists with precedence, no allowlist/exceptions, no query logging or
  stats page beyond the in-memory `proxy.stats` counters.**
- **No rate limiting or other abuse protection** on the proxy's own UDP listener, beyond the loopback-only bind
  guard (same reasoning as `15-dns-resolver`'s stub server: an open resolver with no access control is useful for
  DNS amplification attacks against a third party).
