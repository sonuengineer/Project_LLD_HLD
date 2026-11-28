/**
 * End-to-end tests through a REAL UDP socket: a plain dgram client talks to our SinkholeServer exactly as a
 * browser or OS stub resolver would, and the server's "upstream" is a StubUpstream we fully control (no real
 * network, no port 53 -- both bind to ephemeral high ports, same reasoning as 15-dns-resolver's stub server
 * tests).
 */
import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { BlockList } from "../src/blocklist.js";
import { ResponseCache } from "../src/cache.js";
import { ManualClock } from "../src/clock.js";
import { SinkholeProxy } from "../src/proxy.js";
import { SinkholeServer } from "../src/server.js";
import { StubUpstream, type StubBehavior } from "../src/stub-upstream.js";
import { RCODE, TYPE, buildQuery, decodeResponse } from "../src/wire.js";

let stub: StubUpstream | undefined;
let server: SinkholeServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  if (stub) await stub.close();
  stub = undefined;
  server = undefined;
});

function udpAsk(port: number, buf: Buffer, waitMs = 2000): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      resolve(undefined);
    }, waitMs);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(buf, port, "127.0.0.1");
  });
}

async function start(behavior: (name: string, type: number) => StubBehavior, blocked: string[] = []) {
  stub = new StubUpstream({ behavior });
  const upstream = await stub.listen();
  const proxy = new SinkholeProxy({
    blockList: new BlockList(blocked),
    mode: "sinkhole",
    sinkholeAddress: "0.0.0.0",
    upstream,
    udpTimeoutMs: 300,
    tcpTimeoutMs: 300,
    cache: new ResponseCache({ clock: new ManualClock(0) }),
  });
  server = new SinkholeServer({ proxy, port: 0 });
  const addr = await server.listen();
  return { addr, proxy, stub };
}

const answer: StubBehavior = { kind: "answer", ttl: 300, address: "203.0.113.5" };

describe("SinkholeServer over a real UDP socket, high test port (not 53)", () => {
  it("binds an ephemeral high port, not 53", async () => {
    const { addr } = await start(() => answer);
    expect(addr.port).toBeGreaterThan(1024);
  });

  it("a blocked domain is answered directly, upstream is never contacted", async () => {
    const { addr, stub } = await start(() => answer, ["ads.example.com"]);
    const reply = decodeResponse((await udpAsk(addr.port, buildQuery(1, "ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR); // sinkhole mode
    expect(stub.callCount).toBe(0);
  });

  it("an allowed query is forwarded and the real reply comes back with the client's transaction id", async () => {
    const { addr } = await start(() => answer);
    const reply = decodeResponse((await udpAsk(addr.port, buildQuery(0x9a9a, "news.example.com", TYPE.A)))!);
    expect(reply.header.id).toBe(0x9a9a);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
  });

  it("a second identical query over the real socket is served from cache, not a second upstream call", async () => {
    const { addr, stub } = await start(() => answer);
    await udpAsk(addr.port, buildQuery(1, "news.example.com", TYPE.A));
    await udpAsk(addr.port, buildQuery(2, "news.example.com", TYPE.A));
    expect(stub.callCount).toBe(1);
  });

  it("a truncated upstream UDP reply is retried over TCP, and the client still gets a full answer over UDP", async () => {
    const { addr, stub } = await start(() => ({ kind: "truncate", ttl: 300, address: "203.0.113.9" }));
    const reply = decodeResponse((await udpAsk(addr.port, buildQuery(1, "big.test", TYPE.A)))!);
    expect(reply.header.tc).toBe(false);
    expect(reply.answers).toHaveLength(1);
    expect(stub.calls.map((c) => c.transport)).toEqual(["udp", "tcp"]);
  });

  it("refuses to bind a non-loopback address without allowNonLoopback", async () => {
    stub = new StubUpstream();
    const upstream = await stub.listen();
    const proxy = new SinkholeProxy({ blockList: new BlockList([]), mode: "nxdomain", upstream });
    const bad = new SinkholeServer({ proxy, host: "8.8.8.8", port: 0 });
    await expect(bad.listen()).rejects.toThrow(/refusing to bind/);
  });
});
