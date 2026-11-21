import { describe, expect, it } from "vitest";
import { Parser, ParseError, type Op } from "../src/parser.js";

const LIMITS = { maxControlLine: 64, maxPayload: 32 };

function parseAll(input: string | Buffer, limits = LIMITS): Op[] {
  const ops: Op[] = [];
  new Parser(limits, (op) => ops.push(op)).feed(Buffer.isBuffer(input) ? input : Buffer.from(input));
  return ops;
}

/** Feeds the input in pieces split at the given offsets. */
function parseSplit(input: Buffer, cuts: number[]): Op[] {
  const ops: Op[] = [];
  const p = new Parser(LIMITS, (op) => ops.push(op));
  let at = 0;
  for (const c of [...cuts, input.length]) {
    p.feed(input.subarray(at, c));
    at = c;
  }
  return ops;
}

const text = (op: Op | undefined) => (op && op.op === "PUB" ? op.payload.toString() : undefined);

describe("parser: each operation", () => {
  it("PING and PONG, case-insensitive", () => {
    expect(parseAll("PING\r\nping\r\nPONG\r\n")).toEqual([{ op: "PING" }, { op: "PING" }, { op: "PONG" }]);
  });

  it("CONNECT with a JSON object", () => {
    expect(parseAll('CONNECT {"verbose":true,"echo":false}\r\n')).toEqual([
      { op: "CONNECT", options: { verbose: true, echo: false } },
    ]);
  });

  it("SUB with and without a queue group", () => {
    expect(parseAll("SUB foo.* 1\r\nSUB jobs workers 2\r\n")).toEqual([
      { op: "SUB", subject: "foo.*", queue: undefined, sid: "1" },
      { op: "SUB", subject: "jobs", queue: "workers", sid: "2" },
    ]);
  });

  it("UNSUB with and without max", () => {
    expect(parseAll("UNSUB 1\r\nUNSUB 2 5\r\n")).toEqual([
      { op: "UNSUB", sid: "1", max: undefined },
      { op: "UNSUB", sid: "2", max: 5 },
    ]);
  });

  it("PUB with and without a reply subject, payload read by byte count", () => {
    const ops = parseAll("PUB a 5\r\nhello\r\nPUB b _INBOX.x 0\r\n\r\n");
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ op: "PUB", subject: "a", reply: undefined });
    expect(text(ops[0])).toBe("hello");
    expect(ops[1]).toMatchObject({ op: "PUB", subject: "b", reply: "_INBOX.x" });
    expect(text(ops[1])).toBe("");
  });

  it("a payload may contain CRLF and protocol words; only the byte count decides where it ends", () => {
    const ops = parseAll("PUB a 12\r\nPING\r\nPONG\r\n\r\nPING\r\n");
    expect(text(ops[0])).toBe("PING\r\nPONG\r\n");
    expect(ops[1]).toEqual({ op: "PING" });
  });

  it("HPUB: header length and total length, headers kept at the front of the payload", () => {
    const hdr = "NATS/1.0\r\nA: 1\r\n\r\n"; // 18 bytes
    const ops = parseAll(`HPUB a r 18 21\r\n${hdr}xyz\r\n`);
    expect(ops[0]).toMatchObject({ op: "PUB", subject: "a", reply: "r", headerLen: 18 });
    expect(text(ops[0])).toBe(hdr + "xyz");
  });

  it("PUB has no header length", () => {
    expect(parseAll("PUB a 1\r\nx\r\n")[0]).toMatchObject({ headerLen: undefined });
  });

  it("payload byte count is bytes, not characters", () => {
    const body = Buffer.from("h" + String.fromCharCode(0xe9) + "llo"); // e-acute: 6 bytes in UTF-8, 5 characters
    const ops = parseAll(Buffer.concat([Buffer.from(`PUB a ${body.length}\r\n`), body, Buffer.from("\r\n")]));
    expect(ops[0] && ops[0].op === "PUB" && ops[0].payload.equals(body)).toBe(true);
  });

  it("tabs and repeated spaces between arguments are fine; a bare LF line ending is tolerated", () => {
    expect(parseAll("SUB\tfoo  \t 7\nPING\n")).toEqual([
      { op: "SUB", subject: "foo", queue: undefined, sid: "7" },
      { op: "PING" },
    ]);
  });
});

describe("parser: TCP delivers bytes, not messages", () => {
  const stream = Buffer.from(
    'CONNECT {"verbose":false}\r\nSUB a.b 1\r\nPUB a.b r 7\r\nab\r\ncde\r\nPING\r\nHPUB a.b 12 14\r\nNATS/1.0\r\n\r\nhi\r\nUNSUB 1 3\r\n',
  );

  it("splitting the stream at EVERY possible single offset gives the same operations", () => {
    const expected = parseAll(stream);
    expect(expected).toHaveLength(6);
    for (let cut = 1; cut < stream.length; cut++) {
      expect(parseSplit(stream, [cut]), `cut at ${cut}`).toEqual(expected);
    }
  });

  it("feeding one byte at a time gives the same operations", () => {
    const cuts = Array.from({ length: stream.length - 1 }, (_, i) => i + 1);
    expect(parseSplit(stream, cuts)).toEqual(parseAll(stream));
  });

  it("nothing is left buffered after a complete stream", () => {
    const p = new Parser(LIMITS, () => {});
    p.feed(stream);
    expect(p.buffered).toBe(0);
  });

  it("an incomplete payload is held until the rest arrives", () => {
    const ops: Op[] = [];
    const p = new Parser(LIMITS, (op) => ops.push(op));
    p.feed(Buffer.from("PUB a 10\r\n0123"));
    expect(ops).toHaveLength(0);
    p.feed(Buffer.from("456789\r"));
    expect(ops).toHaveLength(0);
    p.feed(Buffer.from("\n"));
    expect(text(ops[0])).toBe("0123456789");
  });
});

describe("parser: limits and bad input", () => {
  const fails = (input: string, message: string | RegExp) =>
    expect(() => parseAll(input)).toThrowError(new RegExp(message instanceof RegExp ? message.source : message));

  it("unknown operation", () => fails("HELLO\r\n", "Unknown Protocol Operation"));
  it("HPUB header size larger than total", () => fails("HPUB a 20 10\r\n", "bad header size"));
  it("HPUB header size too small to hold NATS/1.0", () => fails("HPUB a 2 4\r\nab\r\n", "bad header size"));
  it("HPUB headers that do not start with NATS/1.0", () => fails("HPUB a 12 12\r\nHTTP/1.1\r\n\r\n\r\n", "must start with NATS/1.0"));
  it("HPUB total over maxPayload (headers count too)", () => fails("HPUB a 12 33\r\n", "Maximum Payload Violation"));
  it("bad CONNECT JSON", () => fails("CONNECT {nope\r\n", "bad JSON"));
  it("CONNECT must be an object", () => fails("CONNECT [1]\r\n", "expected a JSON object"));
  it("PUB with a negative, hex or missing size", () => {
    fails("PUB a -1\r\n", "bad size");
    fails("PUB a 0x10\r\n", "bad size");
    fails("PUB a\r\n", "expected subject");
  });
  it("PUB declaring more than maxPayload is rejected BEFORE the payload is read", () => {
    const ops: Op[] = [];
    const p = new Parser(LIMITS, (op) => ops.push(op));
    expect(() => p.feed(Buffer.from("PUB a 33\r\n"))).toThrowError("Maximum Payload Violation");
    expect(p.buffered).toBe(0);
  });
  it("PUB of exactly maxPayload is accepted", () => {
    expect(text(parseAll(`PUB a 32\r\n${"x".repeat(32)}\r\n`)[0])).toHaveLength(32);
  });
  it("payload longer than declared (no CRLF where the count says) is rejected", () => {
    fails("PUB a 3\r\nhello\r\n", "payload size does not match");
  });
  it("a control line over the limit is rejected even before its newline arrives", () => {
    const p = new Parser(LIMITS, () => {});
    expect(() => p.feed(Buffer.from("SUB " + "a".repeat(80)))).toThrowError("Maximum Control Line Exceeded");
  });
  it("a control line of exactly the limit is accepted", () => {
    const line = "SUB " + "a".repeat(LIMITS.maxControlLine - 6) + " 1"; // 64 chars
    expect(line).toHaveLength(LIMITS.maxControlLine);
    expect(parseAll(line + "\r\n")).toHaveLength(1);
  });
  it("after an error the parser ignores further input", () => {
    const ops: Op[] = [];
    const p = new Parser(LIMITS, (op) => ops.push(op));
    expect(() => p.feed(Buffer.from("BAD\r\n"))).toThrow(ParseError);
    p.feed(Buffer.from("PING\r\n"));
    expect(ops).toHaveLength(0);
  });
  it("operations before an error in the same chunk are still delivered", () => {
    const ops: Op[] = [];
    const p = new Parser(LIMITS, (op) => ops.push(op));
    expect(() => p.feed(Buffer.from("PING\r\nSUB a 1\r\nBAD\r\n"))).toThrow(ParseError);
    expect(ops.map((o) => o.op)).toEqual(["PING", "SUB"]);
  });
});
