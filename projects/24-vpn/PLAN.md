# B-series: build your own VPN (low-level design): plan

Status (2026-11-28): stage 1 DONE (X25519 handshake, ChaCha20-Poly1305 transport, sliding-window anti-replay,
real UDP loopback transport, pseudo-TUN abstraction; 65 tests, 22 mutation checks, 1 survivor closed).

## Why this project

A paid VPN (NordVPN/Surfshark) showed up in a Black Friday deals list. The point of building a tiny one is not
to replace it -- it is to actually understand what "VPN tunnel" means instead of treating it as a black box:
a handshake that proves both ends hold the right keys without ever sending a key over the wire, a symmetric
cipher that both encrypts and authenticates every packet, and a counter-based defense against someone just
replaying a captured packet. Those three ideas (ECDH key exchange, AEAD, anti-replay windows) show up again in
TLS, SSH, and every other secure-channel protocol -- a VPN is just the application that makes them concrete.

## Decisions (one recommendation each)

- **TypeScript, zero runtime dependencies, `node:crypto` for every primitive.** Same rule as the rest of this
  repo: no third-party crypto library, ever. `generateKeyPairSync("x25519")` / `diffieHellman` for ECDH,
  `hkdfSync` to turn raw ECDH output into a usable key, `chacha20-poly1305` for the one AEAD cipher used
  everywhere (handshake messages and transport packets alike).
- **The handshake is a simplified Noise "IK"-style exchange, not a byte-exact port of WireGuard's real wire
  format.** WireGuard's actual handshake also folds in a timestamp (replay protection for the handshake
  itself) and a cookie/MAC mechanism for DoS resistance under load; this project keeps the shape that matters
  for the stated goal (mutual authentication + forward secrecy from the ECDH algebra) and drops the
  operational hardening that is not what stage 1 is trying to teach. See `src/handshake.ts`'s header comment
  for the full two-message exchange and exactly why it authenticates both sides.
- **Two keypairs per peer: one static (long-term identity, exchanged out of band like a WireGuard public key),
  one ephemeral (fresh per handshake attempt, discarded after).** The static key is what `trustPeer()` pins;
  the ephemeral key is what buys forward secrecy -- the session key depends on BOTH ephemeral private keys,
  which exist only in memory for the duration of one handshake, so a later static-key compromise cannot
  decrypt a session recorded earlier.
- **Final transport keys are HKDF over three chained ECDH outputs: static-ephemeral (`dhSE`), ephemeral-static
  (`dhES`), ephemeral-ephemeral (`dhEE`).** `dhSE` alone (what message 1's encryption key is derived from)
  only proves the initiator knew the responder's REAL static public key -- `DH(a.priv, B.pub)` equals
  `DH(b.priv, A.pub)` precisely when `A.pub`/`B.pub` are each party's own real public key, so a wrong key on
  either side makes the two sides compute different values and the next AEAD tag fails to verify. `dhES` and
  `dhEE` are what additionally prove the initiator holds the PRIVATE key matching whatever static public key
  it claimed in message 1 (anyone can claim a real, public static key as their own identity, since public
  keys are not secret -- but only the real holder of the matching private key can compute `dhES`/`dhEE`
  correctly and so derive a session key that actually decrypts anything). This is "wrong public key never
  produces a session" and "no one can forge another peer's identity and get a working session" both falling
  out of the same handful of DH calls, not two separate mechanisms.
- **Every transport packet is tagged with a receiver-chosen id (`myReceiverId`/`peerReceiverId`), not the
  sender's name or address.** Mirrors WireGuard's own receiver index: the party that will receive future
  packets picks the lookup key during the handshake, so decrypting an inbound packet is a single map lookup
  by that id, never a scan or an assumption about which socket address a packet came from (useful once NAT or
  endpoint roaming is in the picture, even though stage 1 does not need to handle either).
- **A classic RFC 6479-style sliding bitmap for anti-replay, not a growing set of seen counters.** Fixed
  memory (`size` bits, default 2048), O(1) accept/reject, exactly the structure real WireGuard uses. The check
  (`check(counter)`) and the mutation (`record(counter)`) are two separate methods on purpose -- see the next
  decision.
- **A counter is checked for replay BEFORE decrypting, and recorded as seen only AFTER the AEAD tag verifies.**
  Checking first avoids paying for a full AEAD decrypt on an obviously-replayed or too-old packet. Recording
  only after authentication matters more: if a forged packet with a guessed counter were marked "seen" before
  its tag is checked, an attacker could burn a counter value the real sender has not used yet, and the real
  sender's later, genuine packet with that counter would be wrongly rejected as a replay. Found by writing it
  the other way first (mutation S2 below) and watching a dedicated test fail.
- **Send and receive use different keys, derived with different HKDF `info` labels (`i2r` / `r2i`).** A single
  shared key used in both directions would mean both peers' counters share one nonce space; the moment both
  sides had sent one packet each, two different packets could reuse nonce 0. Separate keys make each
  direction's counter independent and keep the "never reuse a nonce for a given key" rule trivially true.
- **Pseudo-TUN: `TunDevice` (`send`/`onReceive`, the app's view) is a real interface; the "driver" side
  (`onSend`/`deliver`) lives only on the concrete `InMemoryTunDevice`, not on the interface itself.** An app
  writing to or reading from the tunnel should never need to know whether the other end is a kernel device or
  an in-memory stub; the engine-facing hooks are extra surface a VPN engine (here, `VpnNode`) uses to drive
  the device from both ends, not something the app ever touches.
- **`VpnNode` is scoped to exactly one active remote peer at a time ("point-to-point", per the brief), even
  though `Peer` itself can trust and hold sessions with several named peers.** Keeps the demo and the
  real-socket tests simple (outbound `tun.send()` always has an unambiguous destination) without limiting the
  protocol layer, which is tested with 3+ peers in a couple of places at the `Peer` level.
- **A real OS TUN device is explicitly NOT built.** `/dev/net/tun` on Linux needs root; this environment has
  no elevated privileges and the repo owner's dev machine is Windows besides. `InMemoryTunDevice` plus real
  UDP loopback sockets exercise the entire protocol end to end without one. Same honesty this repo already
  applies elsewhere (16-container-runtime's README is explicit about what needed root and was only measured
  on the owner's Linux server, never built here) -- see README.md's "Known and NOT handled".

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | X25519 handshake with static + ephemeral keypairs, forward secrecy, mutual authentication via DH algebra; ChaCha20-Poly1305 transport with per-session counters; RFC 6479-style anti-replay window; pseudo-TUN abstraction (`TunDevice`/`InMemoryTunDevice`) wired to real UDP loopback sockets (`VpnNode`); randomized invariant test over real sockets with simulated reordering/duplication/tamper; demo; mutation checks | DONE 2026-11-28 |
| 2 | Not decided yet -- candidates: a real Linux `/dev/net/tun` adapter (needs root, would only be demonstrable on the owner's Linux box, not built/tested here), periodic re-handshake / session rekeying on a timer, handshake cookies for DoS resistance, multiple simultaneous peers routed by destination (a real "VPN concentrator" shape instead of point-to-point) | not started |

## Not in scope

Carrying real IP packets (payloads are opaque bytes, by design -- see the project brief); a real OS TUN/TAP
device and the routing table changes a real VPN client makes; NAT traversal / endpoint roaming (WireGuard's
"allowed IPs" and roaming are both bigger topics than stage 1 needs); DoS-resistant handshake cookies; session
rekeying/expiry; IPv6; any configuration file format or CLI -- `Peer`/`VpnNode` are a library, driven directly
from TypeScript, the same shape as every other project in this repo.
