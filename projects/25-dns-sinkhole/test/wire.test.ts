import { describe, expect, it } from "vitest";
import {
  CLASS_IN,
  OPCODE_QUERY,
  RCODE,
  TYPE,
  WireError,
  buildQuery,
  canonicalName,
  decodeHeader,
  decodeQuery,
  decodeResponse,
  emptyHeader,
  encodeARecord,
  encodeMessage,
  nameToLabels,
  readName,
} from "../src/wire.js";

/** Deterministic PRNG (mulberry32) so the fuzz test below is repeatable, never flaky. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A chain of `n` backward-pointing compression pointers, terminating at the root name. */
function buildPointerChain(n: number): { buf: Buffer; start: number } {
  const buf = Buffer.alloc(1 + 2 * n);
  buf[0] = 0; // root terminator
  const posOf = (k: number) => (k === 0 ? 0 : 2 * k - 1);
  for (let k = 1; k <= n; k++) {
    const offset = posOf(k);
    const target = posOf(k - 1);
    buf[offset] = 0xc0 | (target >> 8);
    buf[offset + 1] = target & 0xff;
  }
  return { buf, start: posOf(n) };
}

describe("header + question round trip", () => {
  it("buildQuery / decodeQuery round-trips id, flags and the question", () => {
    const buf = buildQuery(0x1234, "example.com", TYPE.A, true);
    const decoded = decodeQuery(buf);
    expect(decoded.header).toMatchObject({ id: 0x1234, qr: false, opcode: OPCODE_QUERY, rd: true, tc: false });
    expect(decoded.questions).toEqual([{ name: "example.com", type: TYPE.A, class: CLASS_IN }]);
  });

  it("rd=false round-trips too (not just the common rd=true case)", () => {
    const buf = buildQuery(1, "a.test", TYPE.A, false);
    expect(decodeQuery(buf).header.rd).toBe(false);
  });

  it("decodeHeader and decodeQuery both need at least 12 bytes", () => {
    expect(() => decodeHeader(Buffer.alloc(11))).toThrow(WireError);
    expect(() => decodeQuery(Buffer.alloc(11))).toThrow(WireError);
    expect(decodeHeader(Buffer.alloc(12)).id).toBe(0);
  });

  it("a qdcount that promises more questions than are actually present is a truncation, not a crash", () => {
    const buf = buildQuery(1, "a.test", TYPE.A);
    const tampered = Buffer.from(buf);
    tampered.writeUInt16BE(2, 4); // qdcount = 2, but only one question's bytes exist
    expect(() => decodeQuery(tampered)).toThrow(WireError);
  });

  it("the root name is the empty string and encodes as a single zero byte", () => {
    const buf = encodeMessage({ ...emptyHeader(1), qr: true }, [{ name: "", type: TYPE.A, class: CLASS_IN }], []);
    expect(buf[12]).toBe(0); // question starts right after the 12-byte header
    expect(decodeQuery(buf).questions[0]!.name).toBe("");
  });
});

describe("canonicalName", () => {
  it("lowercases and strips one trailing dot", () => {
    expect(canonicalName("WWW.Example.COM.")).toBe("www.example.com");
    expect(canonicalName("already.lower")).toBe("already.lower");
    expect(canonicalName("")).toBe("");
  });
});

describe("name limits (nameToLabels / encode)", () => {
  it("rejects an empty label", () => {
    expect(() => nameToLabels("a..b")).toThrow(WireError);
  });

  it("rejects a label over 63 bytes", () => {
    expect(() => nameToLabels(`${"a".repeat(64)}.com`)).toThrow(WireError);
    expect(() => nameToLabels(`${"a".repeat(63)}.com`)).not.toThrow();
  });

  it("rejects a name whose wire form is over 255 bytes", () => {
    const longName = Array.from({ length: 50 }, () => "a".repeat(5)).join("."); // 50*6 - 1 = 299 bytes
    expect(() => encodeARecord(longName, 1, "1.2.3.4")).toThrow(WireError);
  });
});

describe("readName: compression and loop protection", () => {
  it("decodes plain, uncompressed labels", () => {
    const buf = Buffer.concat([Buffer.from([1, 0x61, 4]), Buffer.from("test"), Buffer.from([0])]); // "a.test"
    const { name, end } = readName(buf, 0);
    expect(name).toBe("a.test");
    expect(end).toBe(buf.length);
  });

  it("follows one backward pointer to an earlier name", () => {
    const { buf, start } = buildPointerChain(1);
    expect(readName(buf, start).name).toBe("");
  });

  it("a chain of exactly MAX_POINTER_JUMPS (32) pointers is accepted", () => {
    const { buf, start } = buildPointerChain(32);
    expect(() => readName(buf, start)).not.toThrow();
  });

  it("a chain of 33 pointers is rejected", () => {
    const { buf, start } = buildPointerChain(33);
    expect(() => readName(buf, start)).toThrow(WireError);
  });

  it("a pointer to itself (or anything not strictly before it) is rejected", () => {
    const buf = Buffer.from([0xc0, 0x00]); // points to offset 0, i.e. itself
    expect(() => readName(buf, 0)).toThrow(WireError);
  });

  it("a reserved label-length bit pattern (0x40/0x80) is rejected", () => {
    expect(() => readName(Buffer.from([0x40, 0, 0]), 0)).toThrow(WireError);
    expect(() => readName(Buffer.from([0x80, 0, 0]), 0)).toThrow(WireError);
  });

  it("a reserved label type is rejected even when enough bytes follow to NOT look truncated (the reserved-type check itself, not a side effect of the bounds check)", () => {
    // 0x40 with 64 bytes following would satisfy every bounds check (claims 64 bytes, 64 bytes are there); only
    // the reserved-type check (0x40 is not a valid label length -- max is 63, 0x3f) catches this.
    const buf = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(64, 0x61), Buffer.from([0])]);
    expect(() => readName(buf, 0)).toThrow(WireError);
  });

  it("a label that claims more bytes than exist is a truncation", () => {
    expect(() => readName(Buffer.from([5, 0x61]), 0)).toThrow(WireError); // claims 5 bytes, only 1 follows
  });

  it("a lone pointer byte with no second byte is a truncation", () => {
    expect(() => readName(Buffer.from([0xc0]), 0)).toThrow(WireError);
  });
});

describe("decodeResponse: reading answer TTLs without decoding rdata", () => {
  it("reads a compressed answer name (pointing at the question) and its TTL, skipping rdata untouched", () => {
    const id = 7;
    const hdr = Buffer.alloc(12);
    hdr.writeUInt16BE(id, 0);
    hdr[2] = 0x80; // qr = 1
    hdr.writeUInt16BE(1, 4); // qdcount
    hdr.writeUInt16BE(1, 6); // ancount
    const qname = Buffer.concat([Buffer.from([1, 0x61]), Buffer.from([4]), Buffer.from("test"), Buffer.from([0])]); // "a.test"
    const qrest = Buffer.alloc(4);
    qrest.writeUInt16BE(TYPE.A, 0);
    qrest.writeUInt16BE(CLASS_IN, 2);
    const pointerToQname = Buffer.from([0xc0, 12]); // offset 12 = right after the header
    const rrRest = Buffer.alloc(10);
    rrRest.writeUInt16BE(TYPE.A, 0);
    rrRest.writeUInt16BE(CLASS_IN, 2);
    rrRest.writeUInt32BE(300, 4);
    rrRest.writeUInt16BE(4, 8); // rdlength
    const rdata = Buffer.from([1, 2, 3, 4]); // never decoded as an address by decodeResponse -- just skipped
    const packet = Buffer.concat([hdr, qname, qrest, pointerToQname, rrRest, rdata]);

    const decoded = decodeResponse(packet);
    expect(decoded.questions[0]!.name).toBe("a.test");
    expect(decoded.answers).toMatchObject([{ name: "a.test", type: TYPE.A, class: CLASS_IN, ttl: 300 }]);
    // ttlOffset must point at the real 4-byte ttl field, so the cache can patch it in place later.
    expect(packet.readUInt32BE(decoded.answers[0]!.ttlOffset)).toBe(300);
  });

  it("an rdlength that runs past the buffer is a truncation, not a wrong read", () => {
    const buf = buildQuery(1, "a.test", TYPE.A);
    const rrHead = Buffer.alloc(10);
    rrHead.writeUInt16BE(TYPE.A, 0);
    rrHead.writeUInt16BE(CLASS_IN, 2);
    rrHead.writeUInt32BE(60, 4);
    rrHead.writeUInt16BE(100, 8); // claims 100 bytes of rdata; none follow
    const nameByte = Buffer.from([0]); // root name for the answer
    const tampered = Buffer.from(buf);
    tampered.writeUInt16BE(1, 6); // ancount = 1
    const packet = Buffer.concat([tampered, nameByte, rrHead]);
    expect(() => decodeResponse(packet)).toThrow(WireError);
  });
});

describe("encodeARecord", () => {
  it("round-trips through decodeResponse with the right name and ttl", () => {
    const q = { name: "x.test", type: TYPE.A, class: CLASS_IN };
    const rr = encodeARecord("x.test", 42, "10.0.0.1");
    const buf = encodeMessage({ ...emptyHeader(1), qr: true, rcode: RCODE.NOERROR }, [q], [rr]);
    const decoded = decodeResponse(buf);
    expect(decoded.answers).toMatchObject([{ name: "x.test", type: TYPE.A, class: CLASS_IN, ttl: 42 }]);
  });

  it("rejects an address that is not a plain IPv4 dotted quad", () => {
    expect(() => encodeARecord("x.test", 1, "not-an-ip")).toThrow(WireError);
    expect(() => encodeARecord("x.test", 1, "1.2.3.4.5")).toThrow(WireError);
    expect(() => encodeARecord("x.test", 1, "1.2.3.999")).toThrow(WireError);
  });
});

describe("fuzz: random and corrupted bytes never throw anything but WireError", () => {
  it("decodeQuery and decodeResponse either succeed or throw WireError, across many random buffers and seeds", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rand = mulberry32(seed);
      for (let i = 0; i < 300; i++) {
        const len = Math.floor(rand() * 40);
        const buf = Buffer.alloc(len);
        for (let j = 0; j < len; j++) buf[j] = Math.floor(rand() * 256);
        try {
          decodeQuery(buf);
        } catch (e) {
          expect(e).toBeInstanceOf(WireError);
        }
        try {
          decodeResponse(buf);
        } catch (e) {
          expect(e).toBeInstanceOf(WireError);
        }
      }
    }
  });

  it("bit-flipping a real query never throws anything but WireError", () => {
    const original = buildQuery(0x55aa, "www.example.com", TYPE.A, true);
    const rand = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const buf = Buffer.from(original);
      const bit = Math.floor(rand() * buf.length * 8);
      const byteIndex = Math.floor(bit / 8);
      buf[byteIndex] = buf[byteIndex]! ^ (1 << bit % 8);
      try {
        decodeQuery(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(WireError);
      }
    }
  });
});
