import { describe, expect, it } from "vitest";
import { generateSharingKeyPair, openAsRecipient, sealForRecipient } from "../src/sharing.js";
import { errorCode } from "./helpers.js";

function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64");
}

describe("generateSharingKeyPair", () => {
  it("returns a PEM public key and a PEM private key, and two calls never collide", () => {
    const a = generateSharingKeyPair();
    const b = generateSharingKeyPair();
    expect(a.publicKey).toContain("PUBLIC KEY");
    expect(a.privateKey).toContain("PRIVATE KEY");
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe("sealForRecipient / openAsRecipient", () => {
  it("round-trips the exact plaintext for the intended recipient", () => {
    const { publicKey, privateKey } = generateSharingKeyPair();
    const plaintext = Buffer.from("a secret worth sharing", "utf8");
    const token = sealForRecipient(publicKey, plaintext);
    expect(openAsRecipient(privateKey, token)).toEqual(plaintext);
  });

  it("a DIFFERENT recipient's private key cannot open it", () => {
    const owner = generateSharingKeyPair();
    const stranger = generateSharingKeyPair();
    const token = sealForRecipient(owner.publicKey, Buffer.from("secret", "utf8"));
    expect(errorCode(() => openAsRecipient(stranger.privateKey, token))).toBe("DECRYPTION_FAILED");
  });

  it("a tampered blob fails authentication, same as every other AES-GCM blob in this project", () => {
    const { publicKey, privateKey } = generateSharingKeyPair();
    const token = sealForRecipient(publicKey, Buffer.from("secret", "utf8"));
    const tampered = { ...token, blob: { ...token.blob, ciphertext: flipFirstByte(token.blob.ciphertext) } };
    expect(errorCode(() => openAsRecipient(privateKey, tampered))).toBe("DECRYPTION_FAILED");
  });

  it("a tampered wrappedKey fails to unwrap", () => {
    const { publicKey, privateKey } = generateSharingKeyPair();
    const token = sealForRecipient(publicKey, Buffer.from("secret", "utf8"));
    const tampered = { ...token, wrappedKey: flipFirstByte(token.wrappedKey) };
    expect(errorCode(() => openAsRecipient(privateKey, tampered))).toBe("DECRYPTION_FAILED");
  });

  it("an invalid recipient public key is rejected up front", () => {
    expect(errorCode(() => sealForRecipient("not a real PEM key", Buffer.from("secret", "utf8")))).toBe("INVALID_REQUEST");
  });

  it("the same plaintext sealed twice never produces the same token (fresh one-time key and IV each time)", () => {
    const { publicKey } = generateSharingKeyPair();
    const plaintext = Buffer.from("same secret", "utf8");
    const a = sealForRecipient(publicKey, plaintext);
    const b = sealForRecipient(publicKey, plaintext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.blob.ciphertext).not.toBe(b.blob.ciphertext);
  });
});
