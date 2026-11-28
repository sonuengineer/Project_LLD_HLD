// Peer is the protocol state machine: identity, trusted peers, in-flight handshakes, and established sessions.
// It has NO knowledge of sockets or addresses -- every method takes or returns plain Buffers, so the whole
// handshake and transport protocol is testable without a single real network call (see test/peer.test.ts).
// Wiring this to real UDP loopback sockets is transport.ts's job.
//
// Two different error policies on purpose (see errors.ts):
//   - "send" methods (initiateHandshake, encryptPacket) are driven by the local program with inputs it
//     controls. Misuse is a programmer error and throws a VpnError, same as the rest of this repo.
//   - "receive" methods (receiveHandshakeInit, receiveHandshakeResponse, decryptPacket) process bytes that
//     came from the network and must NEVER throw -- a malformed, tampered or replayed packet is reported back
//     as a typed rejection so the transport layer can log it and move on.
//
// Stage 2 adds periodic session rekeying (see PLAN.md's "Stage 2 decisions" for the full reasoning). The short
// version: each peer name has a CURRENT session (used for every new encrypt/decrypt) and, for a bounded grace
// period right after a rekey, a RETIRING one -- the session a rekey just replaced, kept around only so any
// packet the peer already sent under the old keys before it learned about the new ones still decrypts. Only
// the side that originally called initiateHandshake() ever re-initiates a rekey; the other side just responds
// to a fresh HANDSHAKE_INIT the same way it always has. checkRekey() is the only new "driver-facing" method --
// callers (tests via ManualClock, VpnNode via a real timer) call it periodically; nothing here starts a timer
// of its own, same rule the rest of this project's time-based logic follows (see clock.ts).
import * as crypto from "node:crypto";
import { type Clock, systemClock } from "./clock.js";
import { generateX25519KeyPair, randomUint32 } from "./crypto-utils.js";
import { VpnError } from "./errors.js";
import {
  buildHandshakeInit,
  buildHandshakeResponse,
  openHandshakeInit,
  openHandshakeResponse,
  type InitiatorHandshakeState,
} from "./handshake.js";
import { Session, type DecryptRejection } from "./session.js";
import { decodeHandshakeResponse, decodeTransportData, transportAad } from "./wire.js";

export type HandshakeInitResult =
  | { ok: true; peerName: string; response: Buffer }
  | { ok: false; reason: "MALFORMED" | "AUTH_FAILED" | "UNTRUSTED_PEER" };

export type HandshakeResponseResult = { ok: true; peerName: string } | { ok: false; reason: "MALFORMED" | "AUTH_FAILED" | "NO_PENDING_HANDSHAKE" };

export type DecryptPacketResult =
  | { ok: true; peerName: string; payload: Buffer }
  | { ok: false; reason: "MALFORMED" | "UNKNOWN_SESSION" | DecryptRejection };

// What armed a rekey for a given peer, returned by checkRekey() so a caller (or a test) can tell which
// configured trigger actually fired. "TIME" wins if both are configured and both would fire at once.
export type RekeyReason = "TIME" | "MESSAGES";
export type RekeyDue = { peerName: string; reason: RekeyReason };

export interface PeerOptions {
  clock?: Clock;
  // Elapsed time since the CURRENT session was established that arms a rekey. Unset (the default) disables
  // the time trigger entirely -- rekeying is opt-in, so a Peer built with no options behaves exactly like
  // stage 1's (no rekeying, ever).
  rekeyAfterMs?: number;
  // Messages sent on the CURRENT session that arms a rekey. Unset disables the count trigger. Either trigger
  // alone is enough to arm rekeying; both may be set at once (whichever fires first wins).
  rekeyAfterMessages?: number;
  // How long a rekey attempt may sit pending (HANDSHAKE_INIT sent, no response yet) before it is abandoned so
  // a fresh attempt can be made. Does NOT apply to a first-ever handshake with a peer (that has no session to
  // protect yet, and VpnNode.connect()'s own real-time timeout already covers it) -- only to a rekey, where an
  // established session is sitting right there, unaffected, the whole time. Default 5000.
  rekeyRetryMs?: number;
  // How long a session a rekey just replaced keeps accepting (and anti-replay-checking) packets addressed to
  // it, before it is dropped for good. Default 10000.
  rekeyGraceMs?: number;
}

interface SessionEntry {
  peerName: string;
  session: Session;
}

// Per-peer-name session bookkeeping. `retiring`, when present, is the session a rekey just superseded -- kept
// reachable (via sessionsByReceiverId, by its OLD receiverId) only until `retireAt`. `generation` counts every
// session ever installed for this peer name (1 = the original handshake, 2+ = each rekey after it) -- it is
// not used for anything protocol-level, just so a caller can observe "a rekey happened" (see
// Peer.sessionGeneration, used by the demo and by tests that need to know a rekey has actually completed).
interface PeerSessionState {
  current: Session;
  establishedAt: number;
  role: "initiator" | "responder";
  generation: number;
  retiring?: { receiverId: number; retireAt: number };
}

export class Peer {
  readonly staticPublicKey: Buffer;
  private readonly staticPrivateKey: crypto.KeyObject;

  private readonly clock: Clock;
  private readonly rekeyAfterMs: number | undefined;
  private readonly rekeyAfterMessages: number | undefined;
  private readonly rekeyRetryMs: number;
  private readonly rekeyGraceMs: number;

  private readonly trustedByName = new Map<string, Buffer>(); // peerName -> their believed static public key
  private readonly trustedByKeyHex = new Map<string, string>(); // believed static public key (hex) -> peerName

  // keyed by OUR initiatorReceiverId
  private readonly pendingHandshakes = new Map<number, InitiatorHandshakeState & { peerName: string; startedAt: number }>();
  private readonly peerSessions = new Map<string, PeerSessionState>();
  private readonly sessionsByReceiverId = new Map<number, SessionEntry>(); // holds CURRENT and retiring sessions alike

  constructor(
    readonly name: string,
    options: PeerOptions = {},
  ) {
    const pair = generateX25519KeyPair();
    this.staticPrivateKey = pair.privateKey;
    this.staticPublicKey = pair.publicKeyRaw;
    this.clock = options.clock ?? systemClock;
    this.rekeyAfterMs = options.rekeyAfterMs;
    this.rekeyAfterMessages = options.rekeyAfterMessages;
    this.rekeyRetryMs = options.rekeyRetryMs ?? 5000;
    this.rekeyGraceMs = options.rekeyGraceMs ?? 10000;
  }

  // Registers the static public key this peer believes belongs to `peerName`, learned out of band (exactly
  // like exchanging WireGuard public keys before either side ever connects). Giving the WRONG key here is
  // exactly the "wrong static public key" scenario this project's tests cover: it can never produce a working
  // session, it just fails differently depending on which side has the wrong key (see PLAN.md).
  trustPeer(peerName: string, staticPublicKey: Buffer): void {
    const previous = this.trustedByName.get(peerName);
    if (previous) this.trustedByKeyHex.delete(previous.toString("hex"));
    this.trustedByName.set(peerName, staticPublicKey);
    this.trustedByKeyHex.set(staticPublicKey.toString("hex"), peerName);
  }

  hasSession(peerName: string): boolean {
    return this.peerSessions.has(peerName);
  }

  // Observability only -- not used by any protocol logic. 1 after the original handshake, incremented once
  // per rekey after that; undefined if no session (or none ever) exists. Lets a caller (demo.ts, tests) tell
  // that a rekey has actually completed without reaching into any key material.
  sessionGeneration(peerName: string): number | undefined {
    return this.peerSessions.get(peerName)?.generation;
  }

  // Initiator side. Returns the HANDSHAKE_INIT bytes to send to `peerName`; the caller (transport.ts) is
  // responsible for actually putting them on the wire. Works just as well to RE-handshake an already-
  // established peer (that is exactly what a rekey is, from this method's point of view -- see checkRekey()).
  initiateHandshake(peerName: string): Buffer {
    const responderStaticKnown = this.trustedByName.get(peerName);
    if (!responderStaticKnown) throw new VpnError("UNKNOWN_PEER", `trustPeer("${peerName}", ...) was never called`);
    if (this.hasPendingHandshake(peerName)) {
      throw new VpnError("HANDSHAKE_IN_PROGRESS", `a handshake with "${peerName}" is already pending`);
    }

    const ephemeral = generateX25519KeyPair();
    const initiatorReceiverId = randomUint32();
    const { message, dhSE } = buildHandshakeInit(
      initiatorReceiverId,
      this.staticPublicKey,
      ephemeral.privateKey,
      ephemeral.publicKeyRaw,
      responderStaticKnown,
    );
    this.pendingHandshakes.set(initiatorReceiverId, {
      peerName,
      ephemeralPrivate: ephemeral.privateKey,
      ephemeralPublicRaw: ephemeral.publicKeyRaw,
      initiatorReceiverId,
      dhSE,
      startedAt: this.clock.now(),
    });
    return message;
  }

  private hasPendingHandshake(peerName: string): boolean {
    for (const pending of this.pendingHandshakes.values()) {
      if (pending.peerName === peerName) return true;
    }
    return false;
  }

  // Responder side. Installs the responder's half of the session as a side effect of a successful call --
  // the responder is done the moment it hands back a response, it does not wait for anything further.
  receiveHandshakeInit(data: Buffer): HandshakeInitResult {
    const opened = openHandshakeInit(this.staticPrivateKey, data);
    if (!opened.ok) return { ok: false, reason: opened.reason };

    const peerName = this.trustedByKeyHex.get(opened.initiatorStaticPublicRaw.toString("hex"));
    if (!peerName) return { ok: false, reason: "UNTRUSTED_PEER" };

    const responderEphemeral = generateX25519KeyPair();
    const responderReceiverId = randomUint32();
    const derived = buildHandshakeResponse(
      responderReceiverId,
      opened.initiatorReceiverId,
      this.staticPrivateKey,
      responderEphemeral.privateKey,
      responderEphemeral.publicKeyRaw,
      opened.initiatorEphemeralPublicRaw,
      opened.initiatorStaticPublicRaw,
      opened.dhSE,
    );

    this.installSession(peerName, derived.sendKey, derived.recvKey, derived.responderReceiverId, opened.initiatorReceiverId, "responder");
    return { ok: true, peerName, response: derived.message };
  }

  // Initiator side. Completes the handshake (installs the initiator's half of the session) on success.
  receiveHandshakeResponse(data: Buffer): HandshakeResponseResult {
    let fields;
    try {
      fields = decodeHandshakeResponse(data);
    } catch {
      return { ok: false, reason: "MALFORMED" };
    }
    const pending = this.pendingHandshakes.get(fields.initiatorReceiverId);
    if (!pending) return { ok: false, reason: "NO_PENDING_HANDSHAKE" };

    const opened = openHandshakeResponse(this.staticPrivateKey, pending.ephemeralPrivate, pending.dhSE, fields);
    if (!opened.ok) return { ok: false, reason: opened.reason };

    this.pendingHandshakes.delete(fields.initiatorReceiverId);
    this.installSession(pending.peerName, opened.keys.sendKey, opened.keys.recvKey, pending.initiatorReceiverId, opened.keys.responderReceiverId, "initiator");
    return { ok: true, peerName: pending.peerName };
  }

  // Installs a brand new session for `peerName`, as either the ORIGINAL handshake or a rekey -- both go
  // through this one path. `defaultRole` is only used the very first time a session is installed for this
  // peer name (role never changes across a rekey: see PLAN.md's "Stage 2 decisions", point 3).
  //
  // If a session already exists, this IS a rekey: the previous session is not torn down, it is marked
  // `retiring` with a grace deadline and left exactly as it was (own keys, own independent anti-replay
  // window, still reachable by its own receiverId) so any packet the peer sent under the old keys before
  // learning about the new ones still decrypts correctly. Only ONE retiring generation is ever kept -- if a
  // previous retiring session had not yet reached its own grace deadline, it is dropped right now instead
  // (see PLAN.md for why that bound is deliberate).
  private installSession(
    peerName: string,
    sendKey: Buffer,
    recvKey: Buffer,
    myReceiverId: number,
    peerReceiverId: number,
    defaultRole: "initiator" | "responder",
  ): void {
    const session = new Session(sendKey, recvKey, myReceiverId, peerReceiverId);
    const now = this.clock.now();
    const previous = this.peerSessions.get(peerName);

    if (previous?.retiring) {
      this.sessionsByReceiverId.delete(previous.retiring.receiverId);
    }

    this.peerSessions.set(peerName, {
      current: session,
      establishedAt: now,
      role: previous?.role ?? defaultRole,
      generation: (previous?.generation ?? 0) + 1,
      retiring: previous ? { receiverId: previous.current.myReceiverId, retireAt: now + this.rekeyGraceMs } : undefined,
    });
    this.sessionsByReceiverId.set(myReceiverId, { peerName, session });
  }

  encryptPacket(peerName: string, payload: Buffer): Buffer {
    const state = this.peerSessions.get(peerName);
    if (!state) throw new VpnError("NO_SESSION", `no established session with "${peerName}"`);
    return state.current.encrypt(payload); // always the CURRENT session -- new outbound traffic switches the instant a rekey installs one
  }

  decryptPacket(data: Buffer): DecryptPacketResult {
    this.pruneRetiredSessions(); // a retiring session past its grace deadline must stop being reachable before we even look it up
    let fields;
    try {
      fields = decodeTransportData(data);
    } catch {
      return { ok: false, reason: "MALFORMED" };
    }
    const entry = this.sessionsByReceiverId.get(fields.receiverId);
    if (!entry) return { ok: false, reason: "UNKNOWN_SESSION" };

    const aad = transportAad(fields.receiverId, fields.counter);
    const result = entry.session.decrypt(fields.counter, fields.ciphertext, fields.tag, aad);
    if (!result.ok) return result;
    return { ok: true, peerName: entry.peerName, payload: result.payload };
  }

  // Drops any retiring session whose grace deadline has passed. Safe (and cheap) to call unconditionally --
  // a peer with no retiring session is a no-op. Called automatically by decryptPacket() and checkRekey(), so
  // normal use never needs to call this directly; it is public so a test can force the check at an exact
  // instant without needing to construct a decrypt/transport call just to trigger it.
  pruneRetiredSessions(now: number = this.clock.now()): void {
    for (const state of this.peerSessions.values()) {
      if (state.retiring && now >= state.retiring.retireAt) {
        this.sessionsByReceiverId.delete(state.retiring.receiverId);
        state.retiring = undefined;
      }
    }
  }

  // The rekey driver. Returns every peer name whose CURRENT session has armed a configured rekey trigger and
  // has no rekey attempt already pending -- the caller (VpnNode.checkRekey, or a test) is responsible for
  // actually calling initiateHandshake() for each one and putting the result on the wire, same "send methods
  // are driven by the local program" split every other method here follows. Only a peer this Peer is the
  // ORIGINAL initiator for is ever reported (see PLAN.md point 3) -- a responder-role session never rekeys on
  // its own, it only ever responds to one.
  checkRekey(now: number = this.clock.now()): RekeyDue[] {
    this.pruneRetiredSessions(now);
    this.abandonStaleRekeyAttempts(now);

    const due: RekeyDue[] = [];
    for (const [peerName, state] of this.peerSessions) {
      if (state.role !== "initiator") continue;
      if (this.hasPendingHandshake(peerName)) continue;

      if (this.rekeyAfterMs !== undefined && now - state.establishedAt >= this.rekeyAfterMs) {
        due.push({ peerName, reason: "TIME" });
      } else if (this.rekeyAfterMessages !== undefined && state.current.sentCount >= this.rekeyAfterMessages) {
        due.push({ peerName, reason: "MESSAGES" });
      }
    }
    return due;
  }

  // A rekey's HANDSHAKE_INIT (or its response) can be lost just like any other UDP datagram. If so, the
  // pending attempt just sits there forever unless something cleans it up -- this is that cleanup. Scoped to
  // ONLY peers that already have an established session (i.e. this is a REKEY attempt, never a first-ever
  // handshake): VpnNode.connect()'s own promise-based timeout already owns the first-handshake case, and
  // abandoning that pending entry here too would race it for no benefit. The old session itself is never
  // touched by any of this -- it keeps working the entire time a rekey attempt is pending, lost, or retried.
  private abandonStaleRekeyAttempts(now: number): void {
    for (const [id, pending] of this.pendingHandshakes) {
      if (this.peerSessions.has(pending.peerName) && now - pending.startedAt >= this.rekeyRetryMs) {
        this.pendingHandshakes.delete(id);
      }
    }
  }
}
