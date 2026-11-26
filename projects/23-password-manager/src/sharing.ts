// Hybrid (envelope) encryption: the same pattern TLS and PGP use. Asymmetric crypto (RSA-OAEP here) is slow
// and can only encrypt a small payload, so it is used ONLY to wrap a fresh one-time AES key; the entry's
// actual content is encrypted with that AES key, through the exact same AEAD as everywhere else in this
// project. This is what lets one vault hand a credential to another vault without either side ever seeing
// the other's master password, vault key, or private key.
import { generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from "node:crypto";
import { decrypt, encrypt, type EncryptedBlob } from "./crypto.js";
import { PasswordManagerError } from "./errors.js";

export interface SharingKeyPair {
  publicKey: string; // PEM, SPKI -- not secret, safe to hand to anyone
  privateKey: string; // PEM, PKCS8 -- the caller is responsible for never storing this unencrypted
}

export interface ShareToken {
  wrappedKey: string; // base64: RSA-OAEP(recipientPublicKey, oneTimeAesKey)
  blob: EncryptedBlob; // AES-256-GCM(oneTimeAesKey, plaintext)
}

const RSA_OPTIONS = { oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING };

export function generateSharingKeyPair(): SharingKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function sealForRecipient(recipientPublicKeyPem: string, plaintext: Buffer): ShareToken {
  const oneTimeKey = randomBytes(32); // AES-256
  const blob = encrypt(oneTimeKey, plaintext);
  let wrappedKey: Buffer;
  try {
    wrappedKey = publicEncrypt({ key: recipientPublicKeyPem, ...RSA_OPTIONS }, oneTimeKey);
  } catch {
    throw new PasswordManagerError("INVALID_REQUEST", "recipientPublicKey is not a valid RSA public key");
  }
  return { wrappedKey: wrappedKey.toString("base64"), blob };
}

export function openAsRecipient(recipientPrivateKeyPem: string, token: ShareToken): Buffer {
  let oneTimeKey: Buffer;
  try {
    oneTimeKey = privateDecrypt({ key: recipientPrivateKeyPem, ...RSA_OPTIONS }, Buffer.from(token.wrappedKey, "base64"));
  } catch {
    // Wrong recipient key or a corrupted wrappedKey -- RSA-OAEP cannot tell these apart, same spirit as
    // crypto.ts's AES-GCM wrapping: the specific reason does not matter, only that it failed.
    throw new PasswordManagerError("DECRYPTION_FAILED", "share token could not be unwrapped with this private key");
  }
  return decrypt(oneTimeKey, token.blob); // already throws DECRYPTION_FAILED on its own failure
}
