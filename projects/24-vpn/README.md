# B-series: build your own VPN (low-level design)

A simplified, WireGuard-style point-to-point encrypted tunnel: an X25519 handshake between two named peers,
ChaCha20-Poly1305 transport with a sliding-window anti-replay check, wired to real UDP loopback sockets. There
is no kernel TUN device -- see "Known and NOT handled" for exactly what that means and why.

Status (2026-11-28): stage 1 DONE, stage 2 (periodic session rekeying) DONE -- 82 tests, 42 mutation checks (1
survivor from stage 1, closed; 0 survivors from stage 2). Details in [PLAN.md](PLAN.md).

```
npm ci
npm test        # 82 tests
npm run demo    # two peers handshake and exchange packets over real loopback UDP, with a replay and a
                # tampered packet both deliberately shown being dropped, then a session rekey happening
                # transparently with traffic still flowing across the boundary
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

### Session rekeying (stage 2)

```ts
import { Peer, VpnNode } from "./src/index.js";

// rekeyAfterMs is deliberately tiny here just so this example's rekey actually happens quickly.
const alicePeer = new Peer("alice", { rekeyAfterMs: 150 });
const bobPeer = new Peer("bob", { rekeyAfterMs: 150 }); // harmless on bob: only the original initiator ever rekeys
alicePeer.trustPeer("bob", bobPeer.staticPublicKey);
bobPeer.trustPeer("alice", alicePeer.staticPublicKey);

const alice = new VpnNode(alicePeer);
const bob = new VpnNode(bobPeer);
const bobPort = await bob.bind(0, "127.0.0.1");
await alice.bind(0, "127.0.0.1");
await alice.connect("bob", "127.0.0.1", bobPort);

alice.tun.send(Buffer.from("before the rekey")); // uses session generation 1

await new Promise((resolve) => setTimeout(resolve, 150)); // let the session age past rekeyAfterMs
alice.checkRekey(); // notices the threshold was crossed, starts a brand new handshake over the wire
alice.tun.send(Buffer.from("still goes out fine, even mid-handshake")); // zero interruption either way

// Or, for real continuous use instead of calling checkRekey() by hand:
//   alice.startRekeyTimer(1000); // checks every second on a real wall-clock interval
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
- **(Stage 2) A session can rekey itself: a time and/or message-count threshold, checked by `checkRekey()`,
  starts a brand new handshake while the OLD session keeps working.** Only the side that originally called
  `initiateHandshake()` ever does this; the old session is kept `retiring` (not deleted) for a configurable
  grace period so any packet the peer already sent under the old keys still decrypts correctly, however the
  two sides happen to interleave switching over. See PLAN.md's "Stage 2 decisions" for the full reasoning.

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
- (Stage 2) Rekeying is opt-in and off by default -- a `Peer` built with no `rekeyAfterMs`/`rekeyAfterMessages`
  behaves exactly like stage 1's, never rekeys, and needed zero changes to stage 1's tests.
- (Stage 2) The old session past a rekey is retired on a grace TIMER, not torn down the instant the new one
  installs -- tearing it down immediately is exactly the race this stage exists to avoid (an in-flight packet
  encrypted under the old keys, received after the new session exists, would otherwise be dropped).

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
| test/rekey.test.ts | 17 | (stage 2) time- and message-count-based triggers fire at the exact configured boundary and not before; a responder-role session never rekeys on its own; no duplicate rekey attempt while one is already pending; a packet encrypted just before a rekey still decrypts after the new session exists; old and new sessions' anti-replay windows are independent (same counter value accepted on each); the old session is retired after its grace period, both via an explicit `pruneRetiredSessions()` call and automatically through `decryptPacket()`; a rapid second rekey immediately retires an already-retiring older session; a lost rekey `HANDSHAKE_INIT` leaves the old session fully usable and a later retry succeeds; `abandonStaleRekeyAttempts` never touches a pending FIRST handshake; role is pinned at first establishment even if the non-initiating side manually re-handshakes; a `startRekeyTimer`/`stopRekeyTimer`/`close()` real-timer lifecycle test; a real-UDP test sending packets across two rekey boundaries with zero packet loss and zero corruption |

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

### Mutation checks -- stage 2 (rekeying)

20 deliberate breaks across `src/peer.ts`'s rekey logic and `src/transport.ts`'s `VpnNode.checkRekey`/timer
lifecycle, same method as stage 1's (one break at a time, full suite run, file restored byte for byte via a
throwaway script never committed, restore in a `finally` block). All 20 were caught on the first run -- 0
survivors, so no test gaps to close this time.

| Area | Breaks |
|---|---|
| `Peer.checkRekey` | RK1 the role guard removed (a responder-role session would rekey on its own), RK2 the already-pending guard removed (piles on a second attempt), RK3 the time-trigger boundary off by one, RK4 the message-count-trigger boundary off by one, RK5 the TIME trigger reports the wrong reason string |
| `Peer.pruneRetiredSessions` / `decryptPacket` | RK6 the grace-deadline boundary off by one, RK16 `decryptPacket`'s automatic prune call removed |
| `Peer.abandonStaleRekeyAttempts` | RK7 the retry-timeout boundary off by one, RK8 the "only a REKEY attempt, never a first handshake" scope guard removed |
| `Peer.installSession` | RK9 the older-retiring-session cleanup removed (a second rapid rekey would leak a receiverId forever), RK10 the old session is never kept retiring at all (hard cutover, breaks in-flight packets), RK11 the retiring entry records the NEW receiverId instead of the OLD one, RK12 role no longer carried forward across a rekey, RK13 the generation counter never increments, RK14 the new session never registered for receive-side lookup |
| `Peer.encryptPacket` | RK15 the `NO_SESSION` guard removed (crashes instead of rejecting) |
| `VpnNode.checkRekey` | TK1 a due rekey never actually calls `initiateHandshake`/sends anything, TK2 the HANDSHAKE_INIT is built but never put on the wire |
| `VpnNode` timer lifecycle | TK3 `stopRekeyTimer` no longer calls `clearInterval` (timer keeps firing), TK4 `close()` no longer stops the rekey timer |

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
  repeatedly to burn CPU. Stage 2's rekeying does not change this -- a REKEY's `HANDSHAKE_INIT` is just as
  replayable as the original one, for the same reason and with the same (lack of) consequence.
- **(Stage 2 note) At most one retiring session per peer name.** If a second rekey lands before the first
  retiring session's grace period elapses, that older session is dropped immediately rather than tracked --
  a deliberate bound (current + at most one retiring = 2 live sessions max per peer), not a general
  multi-generation retention scheme. Misconfiguring `rekeyGraceMs` much longer than the real round-trip time
  between rekeys is the only way this bound is ever reached in practice.
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
