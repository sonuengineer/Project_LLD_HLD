// Pure handshake crypto, no Peer orchestration and no networking -- isolates the ECDH/HKDF/AEAD wiring
// (handshake.ts) from the state-machine bookkeeping (peer.ts, covered in peer.test.ts).
import { describe, expect, it } from "vitest";
import { generateX25519KeyPair, randomUint32 } from "../src/crypto-utils.js";
import { buildHandshakeInit, buildHandshakeResponse, openHandshakeInit, openHandshakeResponse } from "../src/handshake.js";
import { decodeHandshakeResponse } from "../src/wire.js";

function newStatic() {
  return generateX25519KeyPair();
}

describe("handshake", () => {
  it("a full exchange produces matching session keys on both sides", () => {
    const initiatorStatic = newStatic();
    const responderStatic = newStatic();
    const initiatorEphemeral = newStatic();

    const initiatorReceiverId = randomUint32();
    const { message: msg1, dhSE } = buildHandshakeInit(
      initiatorReceiverId,
      initiatorStatic.publicKeyRaw,
      initiatorEphemeral.privateKey,
      initiatorEphemeral.publicKeyRaw,
      responderStatic.publicKeyRaw,
    );

    const opened1 = openHandshakeInit(responderStatic.privateKey, msg1);
    expect(opened1.ok).toBe(true);
    if (!opened1.ok) return;
    expect(opened1.initiatorStaticPublicRaw.equals(initiatorStatic.publicKeyRaw)).toBe(true);
    expect(opened1.dhSE.equals(dhSE)).toBe(true);

    const responderEphemeral = newStatic();
    const responderReceiverId = randomUint32();
    const derived = buildHandshakeResponse(
      responderReceiverId,
      opened1.initiatorReceiverId,
      responderStatic.privateKey,
      responderEphemeral.privateKey,
      responderEphemeral.publicKeyRaw,
      opened1.initiatorEphemeralPublicRaw,
      opened1.initiatorStaticPublicRaw,
      opened1.dhSE,
    );

    const fields2 = decodeHandshakeResponse(derived.message);
    const opened2 = openHandshakeResponse(initiatorStatic.privateKey, initiatorEphemeral.privateKey, dhSE, fields2);
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;

    // The two sides' send/recv keys must be mirror images of each other.
    expect(opened2.keys.sendKey.equals(derived.recvKey)).toBe(true);
    expect(opened2.keys.recvKey.equals(derived.sendKey)).toBe(true);
    expect(opened2.keys.responderReceiverId).toBe(responderReceiverId);
  });

  it("the initiator using the WRONG responder static public key fails message 1 at the responder", () => {
    const initiatorStatic = newStatic();
    const responderStatic = newStatic();
    const wrongResponderKey = newStatic().publicKeyRaw; // NOT responderStatic's real key
    const initiatorEphemeral = newStatic();

    const { message: msg1 } = buildHandshakeInit(
      randomUint32(),
      initiatorStatic.publicKeyRaw,
      initiatorEphemeral.privateKey,
      initiatorEphemeral.publicKeyRaw,
      wrongResponderKey,
    );

    const opened = openHandshakeInit(responderStatic.privateKey, msg1);
    expect(opened).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("a claimed static public key the responder does not recognize is still cryptographically valid (that check lives in peer.ts, not here)", () => {
    // handshake.ts only proves "this initiator knows the responder's real key AND holds the private key
    // matching whatever it claims" -- deciding whether that claim is an ALLOWED peer is Peer's job
    // (trustPeer's reverse lookup). This test documents the split.
    const initiatorStatic = newStatic();
    const responderStatic = newStatic();
    const initiatorEphemeral = newStatic();

    const { message: msg1 } = buildHandshakeInit(
      randomUint32(),
      initiatorStatic.publicKeyRaw,
      initiatorEphemeral.privateKey,
      initiatorEphemeral.publicKeyRaw,
      responderStatic.publicKeyRaw,
    );
    const opened = openHandshakeInit(responderStatic.privateKey, msg1);
    expect(opened.ok).toBe(true);
  });

  it("a malformed message 1 (wrong length) is reported as MALFORMED, not thrown", () => {
    const responderStatic = newStatic();
    const garbage = Buffer.alloc(10, 0xab);
    const opened = openHandshakeInit(responderStatic.privateKey, garbage);
    expect(opened).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("a tampered message 1 ciphertext fails even with the correct responder key", () => {
    const initiatorStatic = newStatic();
    const responderStatic = newStatic();
    const initiatorEphemeral = newStatic();

    const { message: msg1 } = buildHandshakeInit(
      randomUint32(),
      initiatorStatic.publicKeyRaw,
      initiatorEphemeral.privateKey,
      initiatorEphemeral.publicKeyRaw,
      responderStatic.publicKeyRaw,
    );
    const tampered = Buffer.from(msg1);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0x01) & 0xff;

    const opened = openHandshakeInit(responderStatic.privateKey, tampered);
    expect(opened).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("the final session keys depend on the ephemeral keys too: a different ephemeral pair never matches, even with the right statics", () => {
    const initiatorStatic = newStatic();
    const responderStatic = newStatic();
    const initiatorEphemeral = newStatic();

    const initiatorReceiverId = randomUint32();
    const { message: msg1, dhSE } = buildHandshakeInit(
      initiatorReceiverId,
      initiatorStatic.publicKeyRaw,
      initiatorEphemeral.privateKey,
      initiatorEphemeral.publicKeyRaw,
      responderStatic.publicKeyRaw,
    );
    const opened1 = openHandshakeInit(responderStatic.privateKey, msg1);
    expect(opened1.ok).toBe(true);
    if (!opened1.ok) return;

    const responderEphemeral = newStatic();
    const derived = buildHandshakeResponse(
      randomUint32(),
      opened1.initiatorReceiverId,
      responderStatic.privateKey,
      responderEphemeral.privateKey,
      responderEphemeral.publicKeyRaw,
      opened1.initiatorEphemeralPublicRaw,
      opened1.initiatorStaticPublicRaw,
      opened1.dhSE,
    );

    // Initiator tries to open the response with the WRONG ephemeral private key (as if message 1 had never
    // actually been sent with initiatorEphemeral, simulating a mixed-up handshake attempt).
    const wrongEphemeral = newStatic();
    const fields2 = decodeHandshakeResponse(derived.message);
    const opened2 = openHandshakeResponse(initiatorStatic.privateKey, wrongEphemeral.privateKey, dhSE, fields2);
    expect(opened2).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });
});
