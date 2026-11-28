# B-series: build your own VPN (low-level design)

A simplified, WireGuard-style point-to-point encrypted tunnel: an X25519 handshake between two named peers,
ChaCha20-Poly1305 transport with a sliding-window anti-replay check, wired to real UDP loopback sockets. There
is no kernel TUN device -- see "Known and NOT handled" for exactly what that means and why.

Status (2026-11-28): stage 1 DONE -- 65 tests, 22 mutation checks (1 survivor, closed). Details in
[PLAN.md](PLAN.md).

```
npm ci
npm test        # 65 tests
npm run demo    # two peers handshake and exchange packets over real loopback UDP, with a replay and a
                # tampered packet both deliberately shown being dropped
```

## Usage

```ts
import { Peer, VpnNode } from "./src/index.js";

const alicePeer = new Peer("alice");
const bobPeer = new Peer("bob");
// Out-of-band key exchange, exactly like swapping WireGuard public keys before either side connects.
alicePeer.trustPeer("bob", bobPeer.staticPublicKey);
bobPeer.trustPeer("alice", alicePeer.staticPublicKey);

const alice = new VpnNode(alicePeer);
const bob = new VpnNode(bobPeer);
const bobPort = await bob.bind(0, "127.0.0.1");
await alice.bind(0, "127.0.0.1");

bob.tun.onReceive((packet) => console.log("bob got:", packet.toString()));
await alice.connect("bob", "127.0.0.1", bobPort); // handshake over real UDP

alice.tun.send(Buffer.from("hello, bob")); // encrypted, sent over UDP, decrypted, delivered to bob's TunDevice
```

## The rules

- **Every peer has a static (long-term) keypair and a fresh ephemeral keypair per handshake attempt.** The
  static public key is what you hand another peer out of band (`trustPeer`); the ephemeral keys exist only
  for the duration of one handshake and are then discarded, which is what buys forward secrecy -- a later
  static-key compromise cannot decrypt a session recorded earlier.
- **A handshake authenticates both sides through ECDH algebra alone, not a separate signature.**
  `DH(a.priv, B.pub)` only equals `DH(b.priv, A.pub)` when `A.pub`/`B.pub` are each side's real public key, so
  an initiator using the WRONG believed public key for the responder makes the two sides derive different
  keys, and the responder's AEAD tag check on message 1 fails -- the handshake is rejected before any session
  exists, on EITHER side. A responder configured with the wrong expected key for the initiator rejects the
  real initiator too, but differently: message 1 still decrypts (the initiator used the responder's real
  key), but the claimed identity it reveals does not match anything in the responder's trusted-peers list
  (`UNTRUSTED_PEER`). See PLAN.md's "Decisions" for exactly which DH terms do which job.
- **Session keys are HKDF over three chained ECDH outputs (static-ephemeral, ephemeral-static,
  ephemeral-ephemeral), with different keys for each direction.** Omitting any one of the three, or using the
  wrong ephemeral key pair on either side, changes the final key and the handshake's confirmation step fails
  to decrypt -- tested directly in `test/handshake.test.ts`.
- **Every transport packet carries a receiver-chosen id, not the sender's identity or address.** Decrypting an
  inbound packet is a single lookup (`sessionsByReceiverId`) by that id; nothing about dispatch depends on
  which socket address a packet arrived from.
- **Anti-replay is a sliding bitmap over the per-session counter (the AEAD nonce), the same idea real
  WireGuard uses.** A new high counter is always accepted; an out-of-order counter still within the window is
  accepted once and rejected on any later replay; a counter older than the window is rejected outright. The
  check runs BEFORE decrypting (cheap rejection of an obviously bad counter) and the counter is marked seen
  only AFTER the AEAD tag verifies -- recording an unauthenticated counter would let a forged packet with a
  guessed counter burn a value the real sender has not sent yet.
- **A tampered ciphertext or auth tag always fails to decrypt and is dropped, never crashes anything.** AEAD
  gives this for free; every "receive" method in this project (`Peer.decryptPacket`,
  `Peer.receiveHandshakeInit`, `Peer.receiveHandshakeResponse`) returns a typed rejection instead of throwing,
  because it is processing bytes from an untrusted network. "Send" methods (`encryptPacket`,
  `initiateHandshake`), by contrast, throw a `VpnError` on misuse -- those are driven by the local program
  with inputs it controls, same "an error means nothing happened" convention as the rest of this repo.
- **`TunDevice` is the app's view of the tunnel: `send(packet)` to write, `onReceive(cb)` to be told about an
  arrival.** `InMemoryTunDevice` additionally exposes `onSend`/`deliver`, the "driver" side a VPN engine
  (`VpnNode`) hooks into to actually drive the interface -- an app using the former two methods never needs
  to know whether the other end of the tunnel is a kernel device or an in-memory stub.
- **`VpnNode` is point-to-point: one active remote peer per node.** `tun.send()` always has an unambiguous
  destination -- whichever peer the node's handshake most recently completed with. `Peer` itself has no such
  limit (it can trust and hold sessions with several named peers at once; see `test/peer.test.ts`).

## Design choices

See [PLAN.md](PLAN.md) for the full reasoning. In short:

- The handshake is a simplified Noise "IK"-style exchange, not a byte-exact WireGuard wire format -- the
  parts that matter for understanding mutual authentication and forward secrecy are kept; WireGuard's
  handshake-replay timestamp and DoS-resistance cookie mechanism are left out (see "Known and NOT handled").
- The anti-replay window is a fixed-size bitmap (RFC 6479-style), not a growing set of seen counters --
  O(1) and bounded memory regardless of how many packets a session has carried.
- `check()` (pure, no mutation) and `record()` (mutates) are two separate methods on `AntiReplayWindow` on
  purpose, so `Session.decrypt` can check-before-decrypting and record-only-after-authenticating without
  either operation hiding a side effect the other depends on.
- Not used on purpose: a single shared send/receive key (would put both directions' counters in one nonce
  space); a growing replay set instead of a bitmap (unbounded memory); sending the sender's identity or
  address in the transport header (receiver-chosen ids avoid needing either).

## Tests

| File | Tests | What |
|---|---|---|
| test/replay-window.test.ts | 13 | in-order and out-of-order acceptance, exact-replay rejection, the TOO_OLD boundary (exact and off-by-one), sliding the window far forward clears stale bits correctly, malformed (negative/non-integer) counters, constructor validation, a long pseudo-random run of jittered/delayed counters checked against an independently-tracked "seen" set |
| test/wire.test.ts | 9 | `counterNonce` is 12 bytes and distinct per counter, AAD helpers differ on any changed field, round-trips for all three message types (including an empty transport payload), malformed-length/wrong-type-byte buffers always throw |
| test/handshake.test.ts | 6 | a full exchange yields mirrored send/recv keys on both sides, the initiator using the WRONG responder static key fails at the responder (AUTH_FAILED), a malformed message 1 is reported not thrown, a tampered message 1 ciphertext fails, the final keys depend on the ephemeral keypairs (a mismatched ephemeral key never produces a working response) |
| test/session.test.ts | 8 | encrypt/decrypt round trip, counters strictly increase, a tampered ciphertext byte and a tampered tag byte both fail cleanly, an exact replay is rejected, out-of-order packets within the window are each accepted exactly once, a packet far outside the window is TOO_OLD, a forged (unauthenticated) counter is never recorded so the real packet with that counter still works |
| test/peer.test.ts | 16 | end-to-end handshake + transport in both directions, `UNKNOWN_PEER`/`NO_SESSION`/`HANDSHAKE_IN_PROGRESS` guards, the initiator's wrong-static-key case (AUTH_FAILED) and the responder's wrong-expected-key case (UNTRUSTED_PEER) as two distinct failure paths, malformed handshake messages rejected not thrown, a response with no matching pending handshake, replay and tamper rejected through the full API, re-trusting a peer under a corrected key, re-handshaking the same peer after a prior handshake already completed |
| test/transport.test.ts | 8 | the same handshake/transport/replay/tamper scenarios again but over REAL UDP loopback sockets end to end (app write -> encrypt -> UDP send -> UDP receive -> decrypt -> app deliver), both directions, several packets in order, `connect()` timing out when the static key is wrong, `sendRawTo` validation |
| test/invariants.test.ts | 5 | randomized (5 seeds x 300 packets) over real UDP sockets: a shuffled/duplicated/tampered dispatch schedule, asserting every original payload is delivered to the right `InMemoryTunDevice` exactly once with no corruption regardless of delivery order, and every duplicate/tampered packet is dropped and never delivered |

## Mutation checks

22 deliberate breaks, each applied alone with the full suite run against it, the file restored byte for byte
afterward (via a throwaway script kept out of the repo, with the restore in a `finally` block). 21 of 22 were
caught on the first run. One survived and was a real test gap, now closed:

- **P5**: `receiveHandshakeResponse` forgetting to delete the completed attempt from `pendingHandshakes` had
  no test to catch it, because replaying the same message 2 a second time is harmless either way (it
  re-derives the identical keys and overwrites the session with itself). The REAL, observable consequence is
  different: with the stale entry still sitting there, a peer could never start a SECOND handshake with the
  same name after the first one succeeded -- `initiateHandshake`'s own "already pending" guard would wrongly
  see the old, completed attempt and throw `HANDSHAKE_IN_PROGRESS` forever. Added a test
  (`test/peer.test.ts`, "a successful handshake clears its pending entry, so a later re-handshake with the
  same peer is not blocked") asserting a fresh `initiateHandshake` call after a completed handshake does not
  throw.

| Area | Breaks |
|---|---|
| anti-replay window | R1 negative-counter guard dropped, R2 off-by-one on the TOO_OLD boundary, R3 off-by-one on the new-high boundary (lets an exact replay of the highest counter through), R4 stale bits never cleared when the window slides forward, R5 `isSet` addresses the wrong bit |
| session | S1 anti-replay check skipped entirely, S2 a counter recorded as seen BEFORE its tag verifies (lets a forged counter burn a legitimate one), S3 the send counter never advances (nonce reuse), S4 a tampered packet's AEAD exception escapes uncaught instead of being reported |
| peer: handshake | P1 the responder's trusted-peer check removed (`UNTRUSTED_PEER` never fires), P3 the `HANDSHAKE_IN_PROGRESS` guard removed, P5 a completed handshake's pending entry never cleared (closed, see above) |
| peer: transport | P2 a missing session throws a bare `TypeError` instead of `VpnError`, P4 the `UNKNOWN_SESSION` guard removed (crashes instead of rejecting), P6 a new session never registered for receive-side lookup |
| handshake crypto | H1 the two DH terms chained in a different order on the responder than the initiator expects, H2 message 1's AEAD authentication skipped entirely, H3 message 2's AEAD authentication skipped entirely, H4 the ephemeral-ephemeral DH term left out of the key chain |

## Known and NOT handled

- **No real OS TUN/TAP device.** A real VPN hands the kernel a `/dev/net/tun` (Linux) device so the OS routes
  packets destined for the VPN's subnet into the process automatically; that needs root/admin privileges,
  which this environment does not have, and the repo owner's dev machine is Windows besides. `TunDevice` /
  `InMemoryTunDevice` is the honest substitute: the full encrypt/send/receive/decrypt path is real (real UDP
  sockets, real ChaCha20-Poly1305), only the "packets arrive because the kernel routed them here" part is
  simulated by calling `send()`/`deliver()` directly. Same approach this repo already takes elsewhere (see
  16-container-runtime's README on what needed root and was only measured on the owner's Linux server, never
  built here).
- **No handshake-replay protection or DoS-resistance cookie.** Real WireGuard's handshake also includes a
  timestamp (so a captured handshake-init cannot itself be replayed to force an expensive re-handshake) and a
  cookie/MAC mechanism so a flood of fake handshake attempts cannot be used to exhaust CPU with ECDH
  computations. Neither is built here -- a captured `HANDSHAKE_INIT` CAN be replayed, producing a harmless
  extra handshake attempt (not a working session, since the responder just re-derives the same response and
  the real initiator's already-pending attempt is unaffected), but nothing stops an attacker from doing this
  repeatedly to burn CPU.
- **No periodic re-handshake / session rekeying.** A session's keys last for the lifetime of the `Peer`
  object; there is no timer-based rotation the way a real VPN rotates session keys every so often to bound
  how much traffic any one key ever protects.
- **64-bit wire counters are modeled as JS `number`, not `bigint`.** The counter is written/read as an 8-byte
  big-endian integer on the wire (matching a real 64-bit counter's width), but is kept as a `number`
  internally, which is exact only up to 2^53. No test in this project sends anywhere near that many packets
  on one session; a system that genuinely needed to would need `bigint` through `AntiReplayWindow` and
  `Session` as well.
- **No NAT traversal or endpoint roaming.** `VpnNode` learns a peer's address from the first packet it
  receives from them and keeps using it; a real WireGuard client additionally re-learns a peer's address if
  it changes mid-session (roaming) and has specific behavior for peers behind NAT. Neither is built here.
- **Carries opaque byte payloads, not real IP packets.** By design, per the project brief -- there is no IP
  header parsing, no routing table, no interaction with the host's actual network stack beyond the UDP socket
  this project opens itself.
- **One active remote peer per `VpnNode`.** See PLAN.md's "Decisions" -- `Peer` itself has no such limit.
- **No configuration file or CLI.** `Peer`/`VpnNode` are a library driven directly from TypeScript, the same
  shape as every other project in this repo.
