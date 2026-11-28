// Session wraps the anti-replay window and the AEAD calls together with real transport-shaped AAD/nonces --
// this is where "integrity" (a tampered packet fails to decrypt) and "replay" (through the actual encrypt/
// decrypt path, not the bare window) are proven together.
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { hkdf } from "../src/crypto-utils.js";
import { decodeTransportData, transportAad } from "../src/wire.js";

function sessionPair(): { a: Session; b: Session } {
  // Simulate two completed handshakes' worth of keys: a's send key is b's recv key and vice versa, exactly
  // what handshake.ts guarantees once a real handshake completes.
  const k1 = hkdf(Buffer.from("shared-secret-1"), "dir1");
  const k2 = hkdf(Buffer.from("shared-secret-2"), "dir2");
  const a = new Session(k1, k2, 100, 200);
  const b = new Session(k2, k1, 200, 100);
  return { a, b };
}

describe("Session", () => {
  it("a encrypts, b decrypts, and gets back the exact original payload", () => {
    const { a, b } = sessionPair();
    const payload = Buffer.from("hello over the tunnel");
    const wire = a.encrypt(payload);
    const { receiverId, counter, ciphertext, tag } = decode(wire);
    const result = b.decrypt(counter, ciphertext, tag, transportAad(receiverId, counter));
    expect(result).toEqual({ ok: true, payload });
  });

  it("several packets in a row each decrypt correctly and the counter strictly increases", () => {
    const { a, b } = sessionPair();
    for (let i = 0; i < 5; i++) {
      const wire = a.encrypt(Buffer.from(`packet ${i}`));
      const { receiverId, counter, ciphertext, tag } = decode(wire);
      expect(counter).toBe(i);
      const result = b.decrypt(counter, ciphertext, tag, transportAad(receiverId, counter));
      expect(result).toEqual({ ok: true, payload: Buffer.from(`packet ${i}`) });
    }
  });

  it("a tampered ciphertext byte fails to decrypt and does not throw", () => {
    const { a, b } = sessionPair();
    const wire = a.encrypt(Buffer.from("do not corrupt me"));
    const { receiverId, counter, ciphertext, tag } = decode(wire);
    const corrupted = Buffer.from(ciphertext);
    corrupted[0] = (corrupted[0]! ^ 0xff) & 0xff;
    const result = b.decrypt(counter, corrupted, tag, transportAad(receiverId, counter));
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("a tampered auth tag byte fails to decrypt and does not throw", () => {
    const { a, b } = sessionPair();
    const wire = a.encrypt(Buffer.from("do not corrupt my tag"));
    const { receiverId, counter, ciphertext, tag } = decode(wire);
    const corrupted = Buffer.from(tag);
    corrupted[0] = (corrupted[0]! ^ 0xff) & 0xff;
    const result = b.decrypt(counter, ciphertext, corrupted, transportAad(receiverId, counter));
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("an exact replay (same counter, same bytes) is rejected the second time", () => {
    const { a, b } = sessionPair();
    const wire = a.encrypt(Buffer.from("only once"));
    const { receiverId, counter, ciphertext, tag } = decode(wire);
    const aad = transportAad(receiverId, counter);
    expect(b.decrypt(counter, ciphertext, tag, aad)).toEqual({ ok: true, payload: Buffer.from("only once") });
    expect(b.decrypt(counter, ciphertext, tag, aad)).toEqual({ ok: false, reason: "REPLAY" });
  });

  it("packets delivered out of order within the window are all accepted exactly once", () => {
    const { a, b } = sessionPair();
    const wires = [0, 1, 2, 3, 4].map((i) => a.encrypt(Buffer.from(`p${i}`)));
    const outOfOrder = [2, 0, 4, 1, 3];
    for (const idx of outOfOrder) {
      const { receiverId, counter, ciphertext, tag } = decode(wires[idx]!);
      const result = b.decrypt(counter, ciphertext, tag, transportAad(receiverId, counter));
      expect(result).toEqual({ ok: true, payload: Buffer.from(`p${idx}`) });
    }
    // Replaying any of them now must fail.
    for (const idx of outOfOrder) {
      const { receiverId, counter, ciphertext, tag } = decode(wires[idx]!);
      expect(b.decrypt(counter, ciphertext, tag, transportAad(receiverId, counter))).toEqual({ ok: false, reason: "REPLAY" });
    }
  });

  it("a packet far outside the anti-replay window is rejected as too old", () => {
    const { a, b } = sessionPair();
    const first = decode(a.encrypt(Buffer.from("ancient")));
    // Push the counter far ahead so `first` falls outside the window (default window size is 2048).
    for (let i = 0; i < 3000; i++) a.encrypt(Buffer.from("filler"));
    const recent = decode(a.encrypt(Buffer.from("recent")));

    const recentResult = b.decrypt(recent.counter, recent.ciphertext, recent.tag, transportAad(recent.receiverId, recent.counter));
    expect(recentResult.ok).toBe(true);

    const oldResult = b.decrypt(first.counter, first.ciphertext, first.tag, transportAad(first.receiverId, first.counter));
    expect(oldResult).toEqual({ ok: false, reason: "TOO_OLD" });
  });

  it("a forged counter that fails authentication does not get recorded, so the real packet with that counter still works", () => {
    const { a, b } = sessionPair();
    // Build a fake transport message with counter 0 using garbage ciphertext/tag (never actually encrypted by a).
    const fakeAad = transportAad(200, 0);
    const forged = { ciphertext: Buffer.from("not real ciphertext"), tag: Buffer.alloc(16, 0x00) };
    expect(b.decrypt(0, forged.ciphertext, forged.tag, fakeAad)).toEqual({ ok: false, reason: "AUTH_FAILED" });

    // The real sender's genuine counter-0 packet must still be accepted -- the forged attempt must not have
    // burned counter 0 in the anti-replay window.
    const real = decode(a.encrypt(Buffer.from("the real packet")));
    expect(real.counter).toBe(0);
    const result = b.decrypt(real.counter, real.ciphertext, real.tag, transportAad(real.receiverId, real.counter));
    expect(result).toEqual({ ok: true, payload: Buffer.from("the real packet") });
  });
});

function decode(wire: Buffer) {
  return decodeTransportData(wire);
}
