// Byte-layout tests for wire.ts, isolated from crypto and networking. Two things earn a dedicated test here
// rather than being left to show up only indirectly through session/handshake tests:
//   - counterNonce() must produce a DIFFERENT nonce for every counter value. The crypto layer only ever
//     passes it a nonce and never re-derives one itself, so a bug that made it return the same bytes for two
//     different counters would not be caught by "the counter field on the wire increments" tests (that field
//     and the nonce are computed independently) -- it would only show up as silent, undetected key stream
//     reuse in a stream cipher, which is exactly the kind of mistake worth a direct test.
//   - every decode function rejects a malformed buffer by throwing, never by reading garbage out of bounds.
import { describe, expect, it } from "vitest";
import {
  counterNonce,
  decodeHandshakeInit,
  decodeHandshakeResponse,
  decodeTransportData,
  encodeHandshakeInit,
  encodeHandshakeResponse,
  encodeTransportData,
  handshakeInitAad,
  handshakeResponseAad,
  peekMessageType,
  transportAad,
} from "../src/wire.js";

describe("wire", () => {
  it("counterNonce differs for every counter and is always 12 bytes", () => {
    const nonces = [0, 1, 2, 1000, 70000].map(counterNonce);
    for (const n of nonces) expect(n.length).toBe(12);
    const hexValues = nonces.map((n) => n.toString("hex"));
    expect(new Set(hexValues).size).toBe(hexValues.length); // all distinct
  });

  it("counterNonce is 4 zero bytes followed by the counter as an 8-byte big-endian integer", () => {
    const nonce = counterNonce(258); // 0x0102
    expect(nonce.subarray(0, 4)).toEqual(Buffer.alloc(4));
    expect(nonce.subarray(4)).toEqual(Buffer.from([0, 0, 0, 0, 0, 0, 1, 2]));
  });

  it("transportAad differs for different receiverId or counter", () => {
    const base = transportAad(1, 1);
    expect(transportAad(2, 1).equals(base)).toBe(false);
    expect(transportAad(1, 2).equals(base)).toBe(false);
  });

  it("handshakeInitAad and handshakeResponseAad both differ for different ephemeral keys", () => {
    const e1 = Buffer.alloc(32, 1);
    const e2 = Buffer.alloc(32, 2);
    expect(handshakeInitAad(5, e1).equals(handshakeInitAad(5, e2))).toBe(false);
    expect(handshakeResponseAad(5, 6, e1).equals(handshakeResponseAad(5, 6, e2))).toBe(false);
  });

  it("HANDSHAKE_INIT round-trips exactly", () => {
    const fields = { initiatorReceiverId: 42, ephemeralPub: Buffer.alloc(32, 7), ciphertext: Buffer.alloc(32, 9), tag: Buffer.alloc(16, 3) };
    const decoded = decodeHandshakeInit(encodeHandshakeInit(fields));
    expect(decoded.initiatorReceiverId).toBe(fields.initiatorReceiverId);
    expect(decoded.ephemeralPub.equals(fields.ephemeralPub)).toBe(true);
    expect(decoded.ciphertext.equals(fields.ciphertext)).toBe(true);
    expect(decoded.tag.equals(fields.tag)).toBe(true);
  });

  it("HANDSHAKE_RESPONSE round-trips exactly", () => {
    const fields = { responderReceiverId: 1, initiatorReceiverId: 2, ephemeralPub: Buffer.alloc(32, 5), tag: Buffer.alloc(16, 8) };
    const decoded = decodeHandshakeResponse(encodeHandshakeResponse(fields));
    expect(decoded).toEqual(fields);
  });

  it("TRANSPORT_DATA round-trips exactly, including an empty payload", () => {
    const fields = { receiverId: 9, counter: 12345, ciphertext: Buffer.from("secret"), tag: Buffer.alloc(16, 1) };
    const decoded = decodeTransportData(encodeTransportData(fields));
    expect(decoded).toEqual(fields);

    const empty = { receiverId: 9, counter: 0, ciphertext: Buffer.alloc(0), tag: Buffer.alloc(16, 1) };
    expect(decodeTransportData(encodeTransportData(empty))).toEqual(empty);
  });

  it("peekMessageType reads the first byte, or undefined for an empty buffer", () => {
    expect(peekMessageType(Buffer.from([3, 0, 0]))).toBe(3);
    expect(peekMessageType(Buffer.alloc(0))).toBeUndefined();
  });

  it("decode functions throw (never silently misparse) on the wrong length or wrong type byte", () => {
    expect(() => decodeHandshakeInit(Buffer.alloc(10))).toThrow();
    expect(() => decodeHandshakeInit(Buffer.alloc(85))).toThrow(); // right length, type byte is 0, not 1
    expect(() => decodeHandshakeResponse(Buffer.alloc(10))).toThrow();
    expect(() => decodeTransportData(Buffer.alloc(10))).toThrow(); // shorter than the minimum header+tag
    expect(() => decodeTransportData(Buffer.alloc(0))).toThrow();
  });
});
