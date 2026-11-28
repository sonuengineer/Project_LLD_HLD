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
import * as crypto from "node:crypto";
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

interface SessionEntry {
  peerName: string;
  session: Session;
}

export class Peer {
  readonly staticPublicKey: Buffer;
  private readonly staticPrivateKey: crypto.KeyObject;

  private readonly trustedByName = new Map<string, Buffer>(); // peerName -> their believed static public key
  private readonly trustedByKeyHex = new Map<string, string>(); // believed static public key (hex) -> peerName

  private readonly pendingHandshakes = new Map<number, InitiatorHandshakeState & { peerName: string }>(); // keyed by OUR initiatorReceiverId
  private readonly sessionsByPeerName = new Map<string, Session>();
  private readonly sessionsByReceiverId = new Map<number, SessionEntry>();

  constructor(readonly name: string) {
    const pair = generateX25519KeyPair();
    this.staticPrivateKey = pair.privateKey;
    this.staticPublicKey = pair.publicKeyRaw;
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
    return this.sessionsByPeerName.has(peerName);
  }

  // Initiator side. Returns the HANDSHAKE_INIT bytes to send to `peerName`; the caller (transport.ts) is
  // responsible for actually putting them on the wire.
  initiateHandshake(peerName: string): Buffer {
    const responderStaticKnown = this.trustedByName.get(peerName);
    if (!responderStaticKnown) throw new VpnError("UNKNOWN_PEER", `trustPeer("${peerName}", ...) was never called`);
    for (const pending of this.pendingHandshakes.values()) {
      if (pending.peerName === peerName) {
        throw new VpnError("HANDSHAKE_IN_PROGRESS", `a handshake with "${peerName}" is already pending`);
      }
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
    });
    return message;
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

    this.installSession(peerName, derived.sendKey, derived.recvKey, derived.responderReceiverId, opened.initiatorReceiverId);
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
    this.installSession(pending.peerName, opened.keys.sendKey, opened.keys.recvKey, pending.initiatorReceiverId, opened.keys.responderReceiverId);
    return { ok: true, peerName: pending.peerName };
  }

  private installSession(peerName: string, sendKey: Buffer, recvKey: Buffer, myReceiverId: number, peerReceiverId: number): void {
    const session = new Session(sendKey, recvKey, myReceiverId, peerReceiverId);
    this.sessionsByPeerName.set(peerName, session);
    this.sessionsByReceiverId.set(myReceiverId, { peerName, session });
  }

  encryptPacket(peerName: string, payload: Buffer): Buffer {
    const session = this.sessionsByPeerName.get(peerName);
    if (!session) throw new VpnError("NO_SESSION", `no established session with "${peerName}"`);
    return session.encrypt(payload);
  }

  decryptPacket(data: Buffer): DecryptPacketResult {
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
}
