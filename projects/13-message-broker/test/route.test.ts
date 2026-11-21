import { describe, expect, it } from "vitest";
import { RouteParser, encodeInterest, encodeRinfo, encodeRmsg, type RouteOp } from "../src/route.js";

const LIMITS = { maxControlLine: 1024, maxPayload: 64 };
const parse = (input: string | Buffer) => {
  const ops: RouteOp[] = [];
  new RouteParser(LIMITS, (op) => ops.push(op)).feed(Buffer.isBuffer(input) ? input : Buffer.from(input));
  return ops;
};

describe("route protocol", () => {
  it("round-trips every encoder through the parser", () => {
    const stream = Buffer.concat([
      Buffer.from(encodeRinfo("ABC")),
      Buffer.from(encodeInterest("RS+", "orders.>", undefined)),
      Buffer.from(encodeInterest("RS+", "jobs", "workers")),
      Buffer.from(encodeInterest("RS-", "jobs", "workers")),
      encodeRmsg({ s: "orders.eu", r: "_INBOX.x", p: true, q: ["w1", "w2"] }, Buffer.from("he\r\nllo")),
      encodeRmsg({ s: "h", p: false, h: 12 }, Buffer.from("NATS/1.0\r\n\r\nbody")),
      Buffer.from("PING\r\n"),
    ]);
    const ops = parse(stream);
    expect(ops.map((o) => o.op)).toEqual(["RINFO", "RS+", "RS+", "RS-", "RMSG", "RMSG", "PING"]);
    expect(ops[0]).toEqual({ op: "RINFO", serverId: "ABC" });
    expect(ops[1]).toEqual({ op: "RS+", subject: "orders.>", queue: undefined });
    expect(ops[2]).toEqual({ op: "RS+", subject: "jobs", queue: "workers" });
    const m = ops[4] as Extract<RouteOp, { op: "RMSG" }>;
    expect(m.meta).toEqual({ s: "orders.eu", r: "_INBOX.x", p: true, q: ["w1", "w2"] });
    expect(m.payload.toString()).toBe("he\r\nllo");
    expect((ops[5] as Extract<RouteOp, { op: "RMSG" }>).meta.h).toBe(12);

    // and the same stream split at every offset
    for (let cut = 1; cut < stream.length; cut++) {
      const got: RouteOp[] = [];
      const p = new RouteParser(LIMITS, (op) => got.push(op));
      p.feed(stream.subarray(0, cut));
      p.feed(stream.subarray(cut));
      expect(got, `cut ${cut}`).toEqual(ops);
    }
  });

  it.each([
    ["unknown op", "HELLO\r\n", "unknown operation"],
    ["RINFO without server_id", 'RINFO {"x":1}\r\n', "bad RINFO"],
    ["RS+ with a bad subject", "RS+ a..b\r\n", "bad RS+"],
    ["RS+ with a bad queue name", "RS+ a q.x\r\n", "bad RS+"],
    ["RMSG with a wildcard subject", 'RMSG {"s":"a.*","p":true} 1\r\nx\r\n', "bad RMSG"],
    ["RMSG without p", 'RMSG {"s":"a"} 1\r\nx\r\n', "bad RMSG"],
    ["RMSG with a header length over the size", 'RMSG {"s":"a","p":true,"h":20} 10\r\n', "bad RMSG"],
    ["RMSG over max payload", 'RMSG {"s":"a","p":true} 65\r\n', "Maximum Payload Violation"],
    ["RMSG headers without NATS/1.0", 'RMSG {"s":"a","p":true,"h":8} 8\r\nHTTP/1.1\r\n', "bad headers"],
  ])("rejects %s", (_n, input, message) => {
    expect(() => parse(input)).toThrowError(message);
  });
});
