// The handshake is a simplified Noise "IK"-style exchange -- the same shape WireGuard's real handshake is
// built on, reduced to exactly what stage 1 needs. Two messages, each peer's long-term (static) keypair plus
// a fresh (ephemeral) keypair per attempt:
//
//   Initiator -> Responder (message 1): Ei (fresh ephemeral), and the initiator's own static public key,
//     encrypted with a key derived from DH(Ei.priv, Rs.pub) -- Rs.pub being whatever static public key the
//     initiator BELIEVES belongs to the responder (trustPeer()'d earlier, out of band).
//   Responder -> Initiator (message 2): Er (fresh ephemeral), and an empty confirmation payload encrypted
//     with a key derived from chaining THREE Diffie-Hellman outputs together.
//
// Why this authenticates both sides (worked through in PLAN.md's "Decisions"): DH(a.priv, B.pub) only equals
// DH(b.priv, A.pub) when A.pub really is a.priv's own public key and B.pub really is b.priv's own public key.
// So DH(Ei.priv, Rs.pub) computed by the initiator only matches DH(Rs.priv, Ei.pub) computed by the real
// responder if the initiator had the responder's REAL static public key -- if it had the wrong one, the two
// values differ, the derived key differs, and message 1's AEAD tag fails to verify at the responder. That is
// the entire "wrong public key never produces a session" requirement, for free, from ECDH's own algebra.
//
// The responder, in turn, only derives the SAME final key as the initiator if the static public key the
// initiator revealed inside message 1 is one the initiator actually holds the private key for -- forging a
// claimed identity (sending someone else's real, public static key without knowing its private half) lets the
// responder encrypt message 2, but the impostor can never compute the matching DH term to decrypt it, so no
// usable session results for them either way.
import { ecdh, hkdf, aeadDecrypt, aeadEncrypt } from "./crypto-utils.js";
import { importRawPublicKey } from "./crypto-utils.js";
import {
  decodeHandshakeInit,
  encodeHandshakeInit,
  encodeHandshakeResponse,
  handshakeInitAad,
  handshakeResponseAad,
  type HandshakeResponseWire,
} from "./wire.js";
import * as crypto from "node:crypto";

const ZERO_NONCE = Buffer.alloc(12);
const MSG1_INFO = "mini-vpn handshake msg1";
const MSG2_INFO = "mini-vpn handshake msg2";
const I2R_INFO = "mini-vpn transport i2r"; // initiator -> responder direction
const R2I_INFO = "mini-vpn transport r2i"; // responder -> initiator direction

export interface InitiatorHandshakeState {
  ephemeralPrivate: crypto.KeyObject;
  ephemeralPublicRaw: Buffer;
  initiatorReceiverId: number;
  dhSE: Buffer; // DH(Ei.priv, Rs.pub-as-believed) -- kept to feed the final chain once message 2 arrives
}

export function buildHandshakeInit(
  initiatorReceiverId: number,
  initiatorStaticPublicRaw: Buffer,
  initiatorEphemeralPrivate: crypto.KeyObject,
  initiatorEphemeralPublicRaw: Buffer,
  responderStaticPublicKnownRaw: Buffer,
): { message: Buffer; dhSE: Buffer } {
  const dhSE = ecdh(initiatorEphemeralPrivate, importRawPublicKey(responderStaticPublicKnownRaw));
  const key = hkdf(dhSE, MSG1_INFO);
  const aad = handshakeInitAad(initiatorReceiverId, initiatorEphemeralPublicRaw);
  const { ciphertext, tag } = aeadEncrypt(key, ZERO_NONCE, initiatorStaticPublicRaw, aad);
  const message = encodeHandshakeInit({
    initiatorReceiverId,
    ephemeralPub: initiatorEphemeralPublicRaw,
    ciphertext,
    tag,
  });
  return { message, dhSE };
}

export type OpenInitResult =
  | {
      ok: true;
      initiatorReceiverId: number;
      initiatorEphemeralPublicRaw: Buffer;
      initiatorStaticPublicRaw: Buffer;
      dhSE: Buffer;
    }
  | { ok: false; reason: "MALFORMED" | "AUTH_FAILED" };

export function openHandshakeInit(responderStaticPrivate: crypto.KeyObject, data: Buffer): OpenInitResult {
  let fields;
  try {
    fields = decodeHandshakeInit(data);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const dhSE = ecdh(responderStaticPrivate, importRawPublicKey(fields.ephemeralPub));
  const key = hkdf(dhSE, MSG1_INFO);
  const aad = handshakeInitAad(fields.initiatorReceiverId, fields.ephemeralPub);
  try {
    const initiatorStaticPublicRaw = aeadDecrypt(key, ZERO_NONCE, fields.ciphertext, fields.tag, aad);
    return {
      ok: true,
      initiatorReceiverId: fields.initiatorReceiverId,
      initiatorEphemeralPublicRaw: Buffer.from(fields.ephemeralPub),
      initiatorStaticPublicRaw,
      dhSE,
    };
  } catch {
    return { ok: false, reason: "AUTH_FAILED" };
  }
}

export interface ResponderDerivedKeys {
  message: Buffer;
  responderReceiverId: number;
  sendKey: Buffer; // responder encrypts transport data with this
  recvKey: Buffer; // responder decrypts transport data with this
}

// Builds message 2 AND derives the responder's final transport keys in one step -- the responder completes
// its half of the handshake the moment it sends this message; it does not wait for anything further.
export function buildHandshakeResponse(
  responderReceiverId: number,
  initiatorReceiverId: number,
  responderStaticPrivate: crypto.KeyObject,
  responderEphemeralPrivate: crypto.KeyObject,
  responderEphemeralPublicRaw: Buffer,
  initiatorEphemeralPublicRaw: Buffer,
  initiatorStaticPublicRaw: Buffer,
  dhSE: Buffer,
): ResponderDerivedKeys {
  const dhES = ecdh(responderEphemeralPrivate, importRawPublicKey(initiatorStaticPublicRaw));
  const dhEE = ecdh(responderEphemeralPrivate, importRawPublicKey(initiatorEphemeralPublicRaw));
  const chain = Buffer.concat([dhSE, dhES, dhEE]);

  const msg2Key = hkdf(chain, MSG2_INFO);
  const aad = handshakeResponseAad(responderReceiverId, initiatorReceiverId, responderEphemeralPublicRaw);
  const { ciphertext, tag } = aeadEncrypt(msg2Key, ZERO_NONCE, Buffer.alloc(0), aad);
  if (ciphertext.length !== 0) throw new Error("unreachable: empty plaintext must encrypt to empty ciphertext");
  const message = encodeHandshakeResponse({
    responderReceiverId,
    initiatorReceiverId,
    ephemeralPub: responderEphemeralPublicRaw,
    tag,
  });

  return {
    message,
    responderReceiverId,
    sendKey: hkdf(chain, R2I_INFO), // responder -> initiator
    recvKey: hkdf(chain, I2R_INFO), // initiator -> responder
  };
}

export interface InitiatorDerivedKeys {
  responderReceiverId: number;
  sendKey: Buffer; // initiator encrypts transport data with this
  recvKey: Buffer; // initiator decrypts transport data with this
}

export type OpenResponseResult = { ok: true; keys: InitiatorDerivedKeys } | { ok: false; reason: "AUTH_FAILED" };

// Takes the already-decoded, already-demultiplexed message fields (peer.ts must decode the message and look up
// the matching pending handshake by `fields.initiatorReceiverId` BEFORE it can even know which ephemeral key
// pair and dhSE value to pass in here -- there is no "decode the whole thing in one call" shape that works,
// since the lookup key lives inside the thing being decoded).
export function openHandshakeResponse(
  initiatorStaticPrivate: crypto.KeyObject,
  initiatorEphemeralPrivate: crypto.KeyObject,
  dhSE: Buffer,
  fields: HandshakeResponseWire,
): OpenResponseResult {
  const dhES = ecdh(initiatorStaticPrivate, importRawPublicKey(fields.ephemeralPub));
  const dhEE = ecdh(initiatorEphemeralPrivate, importRawPublicKey(fields.ephemeralPub));
  const chain = Buffer.concat([dhSE, dhES, dhEE]);

  const msg2Key = hkdf(chain, MSG2_INFO);
  const aad = handshakeResponseAad(fields.responderReceiverId, fields.initiatorReceiverId, fields.ephemeralPub);
  try {
    aeadDecrypt(msg2Key, ZERO_NONCE, Buffer.alloc(0), fields.tag, aad); // throws on any mismatch
  } catch {
    return { ok: false, reason: "AUTH_FAILED" };
  }

  return {
    ok: true,
    keys: {
      responderReceiverId: fields.responderReceiverId,
      sendKey: hkdf(chain, I2R_INFO), // initiator -> responder
      recvKey: hkdf(chain, R2I_INFO), // responder -> initiator
    },
  };
}
