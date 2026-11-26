import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt, newSalt } from "../src/crypto.js";
import { errorCode } from "./helpers.js";

// Flips one bit in the first byte of a base64-encoded buffer, returning base64 again.
function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64");
}

describe("deriveKey", () => {
  it("is deterministic: same password + same salt -> same key", () => {
    const salt = newSalt();
    expect(deriveKey("hunter2", salt).equals(deriveKey("hunter2", salt))).toBe(true);
  });

  it("a different salt (or a different password) produces a different key", () => {
    const saltA = newSalt();
    const saltB = newSalt();
    expect(deriveKey("hunter2", saltA).equals(deriveKey("hunter2", saltB))).toBe(false);
    expect(deriveKey("hunter2", saltA).equals(deriveKey("hunter3", saltA))).toBe(false);
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips the exact plaintext", () => {
    const key = deriveKey("hunter2", newSalt());
    const plaintext = Buffer.from("a secret worth keeping", "utf8");
    expect(decrypt(key, encrypt(key, plaintext))).toEqual(plaintext);
  });

  it("uses a fresh IV each call: encrypting the same plaintext twice never produces the same ciphertext", () => {
    const key = deriveKey("hunter2", newSalt());
    const plaintext = Buffer.from("same plaintext", "utf8");
    const a = encrypt(key, plaintext);
    const b = encrypt(key, plaintext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("decrypting with the wrong key throws DECRYPTION_FAILED instead of returning garbage", () => {
    const salt = newSalt();
    const blob = encrypt(deriveKey("hunter2", salt), Buffer.from("secret", "utf8"));
    expect(errorCode(() => decrypt(deriveKey("wrong-password", salt), blob))).toBe("DECRYPTION_FAILED");
  });

  it("a ciphertext altered after encryption fails authentication", () => {
    const key = deriveKey("hunter2", newSalt());
    const blob = encrypt(key, Buffer.from("secret", "utf8"));
    const tampered = { ...blob, ciphertext: flipFirstByte(blob.ciphertext) };
    expect(errorCode(() => decrypt(key, tampered))).toBe("DECRYPTION_FAILED");
  });

  it("an altered authTag fails authentication", () => {
    const key = deriveKey("hunter2", newSalt());
    const blob = encrypt(key, Buffer.from("secret", "utf8"));
    const tampered = { ...blob, authTag: flipFirstByte(blob.authTag) };
    expect(errorCode(() => decrypt(key, tampered))).toBe("DECRYPTION_FAILED");
  });

  it("an altered IV fails authentication (it is bound into the tag, not just a nonce)", () => {
    const key = deriveKey("hunter2", newSalt());
    const blob = encrypt(key, Buffer.from("secret", "utf8"));
    const tampered = { ...blob, iv: flipFirstByte(blob.iv) };
    expect(errorCode(() => decrypt(key, tampered))).toBe("DECRYPTION_FAILED");
  });
});
