import dgram from "node:dgram";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Resolver } from "../src/resolver.js";
import { DnsServer, isLoopback } from "../src/server.js";
import { LengthPrefixedReader, frameTcp } from "../src/transport.js";
import { RCODE, TYPE, buildQuery, decodeMessage, encodeMessage, type Message } from "../src/wire.js";
import { BIG_TXT, FAKE_ROOT_HINTS, buildNet } from "./fixtures.js";

const fake = buildNet();
let server: DnsServer;
let port = 0;

beforeAll(async () => {
  await fake.start();
  server = new DnsServer({
    resolver: new Resolver({ rootHints: FAKE_ROOT_HINTS, route: fake.route, timeoutMs: 1000, shuffle: false }),
    port: 0,
  });
  port = (await server.listen()).port;
});
afterAll(async () => {
  await server.close();
  await fake.stop();
});

/** Sends raw bytes to the stub server over UDP; resolves with the reply, or undefined after `waitMs`. */
function udpExchange(buf: Buffer, waitMs = 2000): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      s.close();
      resolve(undefined);
    }, waitMs);
    s.on("message", (msg) => {
      clearTimeout(timer);
      s.close();
      resolve(msg);
    });
    s.send(buf, port, "127.0.0.1");
  });
}

async function ask(name: string, type: number, rd = true): Promise<Message> {
  const reply = await udpExchange(encodeMessage(buildQuery(0x4242, name, type, rd)));
  if (!reply) throw new Error("no reply");
  return decodeMessage(reply);
}

function tcpExchange(frames: Buffer[]): Promise<Message[]> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const reader = new LengthPrefixedReader();
    const out: Message[] = [];
    s.on("connect", () => {
      // all frames in ONE write, the last one split in two, to test framing on the server side
      const all = Buffer.concat(frames.map(frameTcp));
      s.write(all.subarray(0, all.length - 3));
      setTimeout(() => s.write(all.subarray(all.length - 3)), 20);
    });
    s.on("data", (chunk) => {
      for (const f of reader.feed(chunk)) out.push(decodeMessage(f));
      if (out.length === frames.length) {
        s.destroy();
        resolve(out);
      }
    });
    s.on("error", reject);
  });
}

describe("stub server", () => {
  it("answers an A query: same ID, QR and RA set, RD copied, question echoed", async () => {
    const m = await ask("www.alpha.test", TYPE.A);
    expect(m.header).toMatchObject({ id: 0x4242, qr: true, ra: true, rd: true, aa: false, rcode: RCODE.NOERROR });
    expect(m.questions).toEqual([{ name: "www.alpha.test", type: TYPE.A, class: 1 }]);
    expect(m.answers.map((a) => (a.data as { address: string }).address).sort()).toEqual(["192.0.2.80", "192.0.2.81"]);
  });

  it("NXDOMAIN with the SOA in authority; a CNAME chain in the answer", async () => {
    const nx = await ask("nope.alpha.test", TYPE.A);
    expect(nx.header.rcode).toBe(RCODE.NXDOMAIN);
    expect(nx.authority[0]!.type).toBe(TYPE.SOA);
    const alias = await ask("to-beta.alpha.test", TYPE.A);
    expect(alias.answers.map((a) => a.type)).toEqual([TYPE.CNAME, TYPE.A]);
  });

  it("an answer over 512 bytes is truncated on UDP (TC=1, no records) and complete over TCP", async () => {
    const udp = await ask("big.alpha.test", TYPE.TXT);
    expect(udp.header.tc).toBe(true);
    expect(udp.answers).toEqual([]);
    const [tcp] = await tcpExchange([encodeMessage(buildQuery(7, "big.alpha.test", TYPE.TXT, true))]);
    expect(tcp!.header.tc).toBe(false);
    expect(tcp!.answers[0]!.data).toEqual({ kind: "TXT", texts: BIG_TXT });
  });

  it("TCP: several pipelined queries on one connection, the last split across writes", async () => {
    const replies = await tcpExchange([
      encodeMessage(buildQuery(1, "www.alpha.test", TYPE.A, true)),
      encodeMessage(buildQuery(2, "mail.alpha.test", TYPE.A, true)),
    ]);
    expect(replies.map((r) => r.header.id).sort()).toEqual([1, 2]);
  });

  it("garbage with a readable header gets FORMERR with the same ID; less than a header gets nothing", async () => {
    const reply = await udpExchange(Buffer.from([0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c]));
    const m = decodeMessage(reply!);
    expect(m.header).toMatchObject({ id: 0xabcd, qr: true, rcode: RCODE.FORMERR });
    expect(await udpExchange(Buffer.from([1, 2, 3]), 300)).toBeUndefined();
  });

  it("a packet with QR=1 (a response) is dropped, so two servers can never ping-pong", async () => {
    const m = buildQuery(5, "www.alpha.test", TYPE.A);
    m.header.qr = true;
    expect(await udpExchange(encodeMessage(m), 300)).toBeUndefined();
  });

  it("other opcodes, other classes and ANY/AXFR get NOTIMP; zero or two questions get FORMERR", async () => {
    const op = buildQuery(1, "www.alpha.test", TYPE.A);
    op.header.opcode = 2; // STATUS
    expect(decodeMessage((await udpExchange(encodeMessage(op)))!).header.rcode).toBe(RCODE.NOTIMP);
    const ch = buildQuery(1, "version.bind", TYPE.TXT);
    ch.questions[0]!.class = 3; // CHAOS
    expect(decodeMessage((await udpExchange(encodeMessage(ch)))!).header.rcode).toBe(RCODE.NOTIMP);
    for (const t of [TYPE.ANY, 252]) expect((await ask("alpha.test", t)).header.rcode).toBe(RCODE.NOTIMP);
    const none = buildQuery(1, "x", TYPE.A);
    none.questions = [];
    expect(decodeMessage((await udpExchange(encodeMessage(none)))!).header.rcode).toBe(RCODE.FORMERR);
    const two = buildQuery(1, "a.alpha.test", TYPE.A);
    two.questions.push({ name: "b.alpha.test", type: TYPE.A, class: 1 });
    expect(decodeMessage((await udpExchange(encodeMessage(two)))!).header.rcode).toBe(RCODE.FORMERR);
  });

  it("a query with an EDNS OPT record in additional is still answered (the OPT is ignored)", async () => {
    const q = buildQuery(9, "www.alpha.test", TYPE.A, true);
    q.additional.push({ name: "", type: TYPE.OPT, class: 1232, ttl: 0, data: { kind: "RAW", bytes: Buffer.alloc(0) } });
    const m = decodeMessage((await udpExchange(encodeMessage(q)))!);
    expect(m.header.rcode).toBe(RCODE.NOERROR);
    expect(m.additional).toEqual([]);
  });

  it("counts queries in stats()", () => {
    const s = server.stats();
    expect(s.udpQueries).toBeGreaterThan(5);
    expect(s.tcpQueries).toBeGreaterThanOrEqual(3);
    expect(s.formerr).toBeGreaterThanOrEqual(1);
    expect(s.truncated).toBeGreaterThanOrEqual(1);
  });
});

describe("stub server: bind guard", () => {
  it("refuses a non-loopback address unless allowNonLoopback is set", async () => {
    const s = new DnsServer({ resolver: new Resolver(), host: "0.0.0.0", port: 0 });
    await expect(s.listen()).rejects.toThrow(/refusing to bind 0.0.0.0/);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.53")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});
