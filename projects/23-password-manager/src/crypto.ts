// The only module in this project that touches node:crypto. Two primitives, both built into Node -- no
// third-party crypto package:
//   - scrypt to turn a master password into a symmetric key (slow on purpose: makes guessing expensive).
//   - AES-256-GCM to encrypt data with that key. GCM is authenticated: decrypting with the wrong key, or
//     decrypting data that was altered after encryption, throws instead of silently returning garbage. That one
//     property is also how a master password gets VERIFIED -- see manager.ts's "canary".
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { PasswordManagerError } from "./errors.js";

export const KEY_LENGTH = 32; // AES-256
export const SALT_LENGTH = 16;
const IV_LENGTH = 12; // the standard, recommended IV length for GCM
const ALGORITHM = "aes-256-gcm";

export interface EncryptedBlob {
  iv: string; // base64
  ciphertext: string; // base64
  authTag: string; // base64
}

export function newSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

// Deliberately synchronous and deliberately slow (Node's scrypt default cost parameters: N=16384, r=8, p=1,
// about 16 MiB of memory and a few milliseconds). A real attacker guessing passwords offline pays this cost
// for every guess; a real user pays it once per unlock.
export function deriveKey(masterPassword: string, salt: Buffer): Buffer {
  return scryptSync(masterPassword, salt, KEY_LENGTH);
}

export function encrypt(key: Buffer, plaintext: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decrypt(key: Buffer, blob: EncryptedBlob): Buffer {
  const iv = Buffer.from(blob.iv, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  const authTag = Buffer.from(blob.authTag, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Wrong key or altered ciphertext/authTag/iv -- GCM cannot tell these apart, and does not need to.
    throw new PasswordManagerError("DECRYPTION_FAILED", "ciphertext failed authentication (wrong key or tampered data)");
  }
}
