import { describe, expect, it } from "vitest";
import {
  CLASS_IN,
  MAX_POINTER_JUMPS,
  RCODE,
  TYPE,
  WireError,
  buildQuery,
  canonicalName,
  decodeHeader,
  decodeMessage,
  encodeMessage,
  formatIpv6,
  isSubdomain,
  nameToLabels,
  parentName,
  readName,
  type Message,
  type ResourceRecord,
} from "../src/wire.js";

const rr = (name: string, type: number, data: ResourceRecord["data"], ttl = 300): ResourceRecord => ({
  name,
  type,
  class: CLASS_IN,
  ttl,
  data,
});

function sample(): Message {
  return {
    header: { id: 0xbeef, qr: true, opcode: 0, aa: true, tc: false, rd: true, ra: false, rcode: RCODE.NOERROR },
    questions: [{ name: "www.example.test", type: TYPE.A, class: CLASS_IN }],
    answers: [
      rr("www.example.test", TYPE.CNAME, { kind: "CNAME", target: "web.example.test" }),
      rr("web.example.test", TYPE.A, { kind: "A", address: "192.0.2.10" }),
      rr("web.example.test", TYPE.AAAA, { kind: "AAAA", address: "2001:db8::10" }),
    ],
    authority: [
      rr("example.test", TYPE.NS, { kind: "NS", host: "ns1.example.test" }),
      rr("example.test", TYPE.SOA, {
        kind: "SOA",
        mname: "ns1.example.test",
        rname: "hostmaster.example.test",
        serial: 2026112101,
        refresh: 7200,
        retry: 900,
        expire: 1209600,
        minimum: 60,
      }),
    ],
    additional: [
      rr("example.test", TYPE.MX, { kind: "MX", preference: 10, exchange: "mail.example.test" }),
      rr("example.test", TYPE.TXT, { kind: "TXT", texts: ["v=spf1 -all", "", "bytes \u0000ÿ kept"] }),
      rr("10.2.0.192.in-addr.arpa", TYPE.PTR, { kind: "PTR", host: "web.example.test" }),
      rr("example.test", 99, { kind: "RAW", bytes: Buffer.from([1, 2, 3, 0xc0, 0x0c]) }),
    ],
  };
}

/** Small deterministic PRNG so a failing fuzz case can be reproduced. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 12-byte header claiming one question, followed by `body`. */
const withHeader = (body: number[]) => Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...body]);

function expectWireError(buf: Buffer) {
  expect(() => decodeMessage(buf)).toThrow(WireError);
}

describe("wire: round trips", () => {
  it("every supported record type and every header flag survive encode -> decode", () => {
    const m = sample();
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it("header flags are on the right bits", () => {
    const flags = [
      ["qr", 0x80, 2],
      ["aa", 0x04, 2],
      ["tc", 0x02, 2],
      ["rd", 0x01, 2],
      ["ra", 0x80, 3],
    ] as const;
    for (const [flag, bit, byte] of flags) {
      const m = buildQuery(1, "a.test", TYPE.A);
      m.header[flag] = true;
      const buf = encodeMessage(m);
      expect(buf[byte]).toBe(bit);
      expect(decodeMessage(buf).header[flag]).toBe(true);
    }
    const m = buildQuery(1, "a.test", TYPE.A);
    m.header.opcode = 5;
    m.header.rcode = RCODE.NXDOMAIN;
    const buf = encodeMessage(m);
    expect(buf[2]).toBe(5 << 3);
    expect(buf[3]).toBe(3);
  });

  it("an unknown type keeps its rdata bytes as they are (RFC 3597)", () => {
    const m = buildQuery(7, "x.test", 65000);
    m.answers.push(rr("x.test", 65000, { kind: "RAW", bytes: Buffer.from("opaque") }));
    const out = decodeMessage(encodeMessage(m));
    expect(out.answers[0]!.data).toEqual({ kind: "RAW", bytes: Buffer.from("opaque") });
  });

  it("the root name is written as one zero byte", () => {
    const buf = encodeMessage(buildQuery(1, "", TYPE.NS));
    expect([...buf.subarray(12)]).toEqual([0, 0, 2, 0, 1]);
    expect(decodeMessage(buf).questions[0]!.name).toBe("");
  });

  it("a label containing a dot or a non-printable byte is escaped, and round-trips as ONE label", () => {
    const name = "a\\.b\\007c.example.test";
    expect(nameToLabels(name).map((l) => [...l])).toEqual([
      [0x61, 0x2e, 0x62, 0x07, 0x63],
      [...Buffer.from("example")],
      [...Buffer.from("test")],
    ]);
    const out = decodeMessage(encodeMessage(buildQuery(1, name, TYPE.A)));
    expect(out.questions[0]!.name).toBe(name);
  });

  it("IPv6 text follows RFC 5952", () => {
    const f = (hex: string) => formatIpv6(Buffer.from(hex, "hex"));
    expect(f("20010db8000000000000000000000001")).toBe("2001:db8::1");
    expect(f("00000000000000000000000000000000")).toBe("::");
    expect(f("20010db8000000010000000000000001")).toBe("2001:db8:0:1::1");
    expect(f("20010db8000100010001000100010001")).toBe("2001:db8:1:1:1:1:1:1");
    expect(f("20010db8000000010001000000000000")).toBe("2001:db8:0:1:1::"); // longest run wins
    expect(f("20010db8000100000001000100010001")).toBe("2001:db8:1:0:1:1:1:1"); // one zero group is not "::"
  });
});

describe("wire: name compression", () => {
  it("encoding compresses repeated suffixes, case-insensitively, and is much smaller", () => {
    const m = sample();
    m.answers.push(rr("WWW.EXAMPLE.TEST", TYPE.A, { kind: "A", address: "192.0.2.11" }));
    const small = encodeMessage(m);
    const big = encodeMessage(m, { compress: false });
    expect(small.length).toBeLessThan(big.length - 100);
    // compression is case-insensitive, so the repeat comes back in the case of the FIRST occurrence
    const fromBig = decodeMessage(big);
    fromBig.answers[3]!.name = "www.example.test";
    expect(decodeMessage(small)).toEqual(fromBig);
    // the question name is at offset 12; the upper-case repeat must be a pointer to it
    expect(small.includes(Buffer.from([0xc0, 12]))).toBe(true);
  });

  it("decodes the RFC 1035 4.1.4 example: F.ISI.ARPA, FOO.F.ISI.ARPA, ARPA, root", () => {
    const buf = Buffer.alloc(100);
    // offset 20: F.ISI.ARPA
    Buffer.from([1, 0x46, 3, 0x49, 0x53, 0x49, 4, 0x41, 0x52, 0x50, 0x41, 0]).copy(buf, 20);
    // offset 40: FOO + pointer to 20
    Buffer.from([3, 0x46, 0x4f, 0x4f, 0xc0, 20]).copy(buf, 40);
    // offset 64: pointer to 26 (ARPA)
    Buffer.from([0xc0, 26]).copy(buf, 64);
    // offset 92: root
    buf[92] = 0;
    expect(readName(buf, 20)).toEqual({ name: "F.ISI.ARPA", end: 32 });
    expect(readName(buf, 40)).toEqual({ name: "FOO.F.ISI.ARPA", end: 46 });
    expect(readName(buf, 64)).toEqual({ name: "ARPA", end: 66 });
    expect(readName(buf, 92)).toEqual({ name: "", end: 93 });
  });

  it("a pointer to itself is rejected (loop)", () => {
    expectWireError(withHeader([0xc0, 12, 0, 1, 0, 1]));
  });

  it("a two-pointer loop A -> B -> A is rejected", () => {
    // offset 12: label "a" then pointer to 16; offset 16: pointer back to 12
    const buf = Buffer.alloc(40);
    Buffer.from([1, 0x61, 0xc0, 16, 0xc0, 12]).copy(buf, 12);
    expect(() => readName(buf, 12)).toThrow(/does not point backwards/);
    expect(() => readName(buf, 16)).toThrow(WireError);
  });

  it("a forward pointer is rejected even when it would not loop", () => {
    // question name at 12 points forward to 18 where a valid name sits
    const buf = withHeader([0xc0, 18, 0, 1, 0, 1, 1, 0x61, 0]);
    expect(() => decodeMessage(buf)).toThrow(/does not point backwards/);
  });

  it(`a backwards chain of more than ${MAX_POINTER_JUMPS} pointers is rejected; exactly ${MAX_POINTER_JUMPS} is fine`, () => {
    const chain = (n: number) => {
      const buf = Buffer.alloc(14 + 2 * n);
      buf[12] = 0; // root at 12
      for (let i = 0; i < n; i++) {
        const at = 13 + 2 * i;
        const target = i === 0 ? 12 : at - 2;
        buf[at] = 0xc0 | (target >> 8);
        buf[at + 1] = target & 0xff;
      }
      return { buf, last: 13 + 2 * (n - 1) };
    };
    const ok = chain(MAX_POINTER_JUMPS);
    expect(readName(ok.buf, ok.last).name).toBe("");
    const bad = chain(MAX_POINTER_JUMPS + 1);
    expect(() => readName(bad.buf, bad.last)).toThrow(/more than/);
  });

  it("a pointer past the end of the packet is rejected", () => {
    expectWireError(withHeader([0xc0])); // half a pointer
    const buf = Buffer.alloc(20);
    buf[18] = 0xc0;
    buf[19] = 0xff; // target 255, beyond 20 bytes but also forward
    expect(() => readName(buf, 18)).toThrow(WireError);
  });
});

describe("wire: limits and malformed input", () => {
  it("names over 255 bytes are rejected on decode and on encode; labels over 63 on encode", () => {
    const labels: number[] = [];
    for (let i = 0; i < 5; i++) labels.push(63, ...Array<number>(63).fill(0x61));
    expectWireError(withHeader([...labels, 0, 0, 1, 0, 1]));
    expect(() => encodeMessage(buildQuery(1, Array(5).fill("a".repeat(63)).join("."), TYPE.A))).toThrow(/255/);
    expect(() => encodeMessage(buildQuery(1, "a".repeat(64) + ".test", TYPE.A))).toThrow(/63/);
    // 4 x 63 + 3 = 255 bytes on the wire, the largest legal name
    const max = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(decodeMessage(encodeMessage(buildQuery(1, max, TYPE.A))).questions[0]!.name).toBe(max);
  });

  it("reserved label types 0x40 and 0x80 are rejected", () => {
    expectWireError(withHeader([0x41, 0x61, 0, 0, 1, 0, 1]));
    expectWireError(withHeader([0x81, 0x61, 0, 0, 1, 0, 1]));
  });

  it("rdlength must match the record type and the bytes the rdata really uses", () => {
    const m = buildQuery(1, "a.test", TYPE.A);
    m.answers.push(rr("a.test", TYPE.A, { kind: "A", address: "192.0.2.1" }));
    const buf = encodeMessage(m);
    const rdlenAt = buf.length - 6;
    expect(buf.readUInt16BE(rdlenAt)).toBe(4);
    const five = Buffer.concat([buf, Buffer.from([0])]);
    five.writeUInt16BE(5, rdlenAt);
    expect(() => decodeMessage(five)).toThrow(/rdlength 5/);
    // a CNAME whose name runs past its rdlength
    const c = buildQuery(1, "a.test", TYPE.CNAME);
    c.answers.push(rr("a.test", TYPE.CNAME, { kind: "CNAME", target: "longer-target.test" }));
    const cb = encodeMessage(c);
    const at = 12 + 12 + 10; // header, question (8-byte name + type + class), answer name pointer + type/class/ttl
    expect(cb.readUInt16BE(at)).toBe(16); // 1 + 13 label bytes + a pointer to "test"
    cb.writeUInt16BE(5, at);
    expect(() => decodeMessage(cb)).toThrow(WireError);
  });

  it("a count larger than the packet is a clean error, not a huge allocation", () => {
    const buf = encodeMessage(buildQuery(1, "a.test", TYPE.A));
    buf.writeUInt16BE(0xffff, 6); // ancount = 65535 with no answers present
    expect(() => decodeMessage(buf)).toThrow(/truncated/);
  });

  it("decodeHeader reads the id of a packet whose body is garbage", () => {
    const buf = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0]);
    expect(decodeHeader(buf).id).toBe(0x1234);
    expect(decodeHeader(buf).rd).toBe(true);
    expect(() => decodeHeader(Buffer.alloc(11))).toThrow(WireError);
  });

  it("fuzz: every truncation of a valid packet throws WireError (and nothing else)", () => {
    const full = encodeMessage(sample());
    for (let n = 0; n < full.length; n++) {
      // cutting inside the last record must fail; some earlier cuts may still parse if counts are satisfied,
      // which cannot happen here because every section count is non-zero
      expect(() => decodeMessage(full.subarray(0, n)), `cut at ${n}`).toThrow(WireError);
    }
    expect(() => decodeMessage(full)).not.toThrow();
  });

  it("fuzz: 3000 random packets and 3000 bit-flipped packets either decode or throw WireError, quickly", () => {
    const rand = prng(15);
    const valid = encodeMessage(sample());
    const started = Date.now();
    let decoded = 0;
    let rejected = 0;
    const tryOne = (buf: Buffer) => {
      try {
        decodeMessage(buf);
        decoded++;
      } catch (e) {
        if (!(e instanceof WireError)) throw new Error(`non-WireError for ${buf.toString("hex")}: ${String(e)}`);
        rejected++;
      }
    };
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rand() * 600);
      const buf = Buffer.alloc(len);
      for (let j = 0; j < len; j++) buf[j] = Math.floor(rand() * 256);
      // bias towards compression pointers so the loop paths are exercised
      for (let j = 12; j < len; j += 7) if (rand() < 0.3) buf[j] = 0xc0 | Math.floor(rand() * 4);
      tryOne(buf);
    }
    for (let i = 0; i < 3000; i++) {
      const buf = Buffer.from(valid);
      const flips = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < flips; k++) {
        const at = Math.floor(rand() * buf.length);
        buf[at] = buf[at]! ^ (1 << Math.floor(rand() * 8));
      }
      tryOne(buf);
    }
    expect(decoded + rejected).toBe(6000);
    expect(rejected).toBeGreaterThan(3000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("wire: name helpers", () => {
  it("canonicalName lowercases ASCII and drops the trailing dot", () => {
    expect(canonicalName("WWW.Example.TEST.")).toBe("www.example.test");
    expect(canonicalName(".")).toBe("");
  });

  it("isSubdomain compares whole labels", () => {
    expect(isSubdomain("www.example.test", "example.test")).toBe(true);
    expect(isSubdomain("example.test", "example.test")).toBe(true);
    expect(isSubdomain("anything.test", "")).toBe(true);
    expect(isSubdomain("badexample.test", "example.test")).toBe(false);
    expect(isSubdomain("a\\.example.test", "example.test")).toBe(false);
    expect(isSubdomain("EXAMPLE.test", "example.TEST")).toBe(true);
    expect(isSubdomain("test", "example.test")).toBe(false);
  });

  it("parentName removes one label", () => {
    expect(parentName("www.example.test")).toBe("example.test");
    expect(parentName("test")).toBe("");
  });
});
