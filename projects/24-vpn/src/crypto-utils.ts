// Thin wrappers around node:crypto. This repo never uses a third-party crypto library (see other projects'
// PLAN.md files) -- everything here is primitives the standard library already provides:
//   - X25519 ECDH for the handshake (generateKeyPairSync("x25519"), diffieHellman)
//   - HKDF to turn a raw ECDH shared secret into a key that is safe to use directly (hkdfSync)
//   - ChaCha20-Poly1305 as the one AEAD cipher for everything encrypted, handshake and transport alike
import * as crypto from "node:crypto";

const X25519_KEY_LEN = 32;
export const AUTH_TAG_LENGTH = 16;
const HKDF_SALT = Buffer.from("mini-vpn-v1"); // fixed, public, application-specific salt (not a secret)

export interface KeyPair {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  publicKeyRaw: Buffer; // the 32 raw bytes -- this is what you hand another peer out of band (trustPeer)
}

export function generateX25519KeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return { publicKey, privateKey, publicKeyRaw: exportRawPublicKey(publicKey) };
}

// X25519 public keys have no secret structure -- JWK's raw "x" coordinate is the same 32 bytes WireGuard shows
// you as a base64 public key. This is the only round trip this project needs: raw bytes on the wire -> a
// KeyObject node:crypto's ECDH functions accept.
export function exportRawPublicKey(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an X25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

export function importRawPublicKey(raw: Buffer): crypto.KeyObject {
  if (raw.length !== X25519_KEY_LEN) throw new Error(`expected a ${X25519_KEY_LEN}-byte X25519 public key`);
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export function ecdh(privateKey: crypto.KeyObject, publicKey: crypto.KeyObject): Buffer {
  return crypto.diffieHellman({ privateKey, publicKey });
}

// Turns raw, possibly-biased ECDH output into a uniform 32-byte key. `info` separates every distinct use of
// HKDF in this project (handshake message 1, message 2, the two transport directions) so that even though they
// all ultimately derive from the same few ECDH outputs, no two of them ever produce the same key.
export function hkdf(ikm: Buffer, info: string, length = 32): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, HKDF_SALT, Buffer.from(info, "utf8"), length));
}

export function aeadEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): { ciphertext: Buffer; tag: Buffer } {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

// Throws if the tag (or AAD) does not match -- a tampered ciphertext, a tampered tag, or a tampered AAD field
// never produces output, it always throws. Callers that must not crash on untrusted input (anything decrypting
// bytes that came off the wire) catch this.
export function aeadDecrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function randomUint32(): number {
  return crypto.randomBytes(4).readUInt32BE(0);
}
