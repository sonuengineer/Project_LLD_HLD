import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Broker, BrokerOptions } from "../src/server.js";
import { Raw, startBroker, until } from "./helpers.js";

let broker: Broker | undefined;
const opened: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const r of opened.splice(0)) r.close();
  await broker?.close(500);
  broker = undefined;
});

async function setup(opts: BrokerOptions = {}) {
  const s = await startBroker(opts);
  broker = s.broker;
  const client = async (connect: Record<string, unknown> = {}) => {
    const r = await Raw.ready(s.port, connect);
    opened.push(r);
    return r;
  };
  return { ...s, client };
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe("queue groups", () => {
  it("each message goes to exactly ONE member of the group; plain subscribers still get every message", async () => {
    const { client } = await setup();
    const w1 = await client();
    const w2 = await client();
    const plain = await client();
    const pub = await client();
    w1.send("SUB jobs workers 1\r\n");
    w2.send("SUB jobs workers 1\r\n");
    plain.send("SUB jobs 1\r\n");
    await Promise.all([w1.sync(), w2.sync(), plain.sync()]);
    for (let i = 0; i < 200; i++) pub.send(`PUB jobs 1\r\nx\r\n`);
    await pub.sync();
    await Promise.all([w1.sync(), w2.sync(), plain.sync()]);
    const a = count(w1.received, /MSG jobs/g);
    const b = count(w2.received, /MSG jobs/g);
    expect(a + b).toBe(200);
    expect(a).toBeGreaterThan(0); // random pick: all 200 to one member has probability 2^-199
    expect(b).toBeGreaterThan(0);
    expect(count(plain.received, /MSG jobs/g)).toBe(200);
  });

  it("two different groups on the same subject each get every message once", async () => {
    const { client } = await setup();
    const a1 = await client();
    const a2 = await client();
    const b1 = await client();
    const pub = await client();
    a1.send("SUB ev ga 1\r\n");
    a2.send("SUB ev ga 1\r\n");
    b1.send("SUB ev gb 1\r\n");
    await Promise.all([a1.sync(), a2.sync(), b1.sync()]);
    for (let i = 0; i < 50; i++) pub.send(`PUB ev 1\r\nx\r\n`);
    await pub.sync();
    await Promise.all([a1.sync(), a2.sync(), b1.sync()]);
    expect(count(a1.received, /MSG ev/g) + count(a2.received, /MSG ev/g)).toBe(50);
    expect(count(b1.received, /MSG ev/g)).toBe(50);
  });

  it("wildcard subscriptions can share a queue group with literal ones", async () => {
    const { client } = await setup();
    const w1 = await client();
    const w2 = await client();
    const pub = await client();
    w1.send("SUB orders.* q 1\r\n");
    w2.send("SUB orders.eu q 1\r\n");
    await Promise.all([w1.sync(), w2.sync()]);
    for (let i = 0; i < 40; i++) pub.send(`PUB orders.eu 1\r\nx\r\n`);
    await pub.sync();
    await Promise.all([w1.sync(), w2.sync()]);
    expect(count(w1.received, /MSG orders\.eu/g) + count(w2.received, /MSG orders\.eu/g)).toBe(40);
  });

  it("after a member unsubscribes, the remaining member gets everything", async () => {
    const { client } = await setup();
    const w1 = await client();
    const w2 = await client();
    const pub = await client();
    w1.send("SUB jobs w 1\r\n");
    w2.send("SUB jobs w 7\r\n");
    await Promise.all([w1.sync(), w2.sync()]);
    w2.send("UNSUB 7\r\n");
    await w2.sync();
    for (let i = 0; i < 30; i++) pub.send(`PUB jobs 1\r\nx\r\n`);
    await pub.sync();
    await Promise.all([w1.sync(), w2.sync()]);
    expect(count(w1.received, /MSG jobs/g)).toBe(30);
    expect(w2.received).toBe("");
  });

  it("a member that publishes with echo:false is never picked for its own message", async () => {
    const { client } = await setup();
    const self = await client({ echo: false });
    const other = await client();
    self.send("SUB t g 1\r\n");
    other.send("SUB t g 1\r\n");
    await Promise.all([self.sync(), other.sync()]);
    for (let i = 0; i < 40; i++) self.send(`PUB t 1\r\nx\r\n`);
    await self.sync();
    await other.sync();
    expect(count(other.received, /MSG t/g)).toBe(40);
    expect(self.received).toBe("");
  });

  it("auto-unsubscribe works for a queue member", async () => {
    const { client, broker } = await setup();
    const w = await client();
    const pub = await client();
    w.send("SUB jobs w 1\r\nUNSUB 1 3\r\n");
    await w.sync();
    for (let i = 0; i < 10; i++) pub.send(`PUB jobs 1\r\nx\r\n`);
    await pub.sync();
    await w.sync();
    expect(count(w.received, /MSG jobs/g)).toBe(3);
    expect(broker.stats().subscriptions).toBe(0);
  });
});

describe("headers", () => {
  const HDR = "NATS/1.0\r\nTrace: 7\r\n\r\n"; // 22 bytes

  it("a client that asked for headers gets HMSG with header and total sizes", async () => {
    const { client } = await setup();
    const sub = await client({ headers: true });
    const pub = await client({ headers: true });
    sub.send("SUB h 5\r\n");
    await sub.sync();
    pub.send(`HPUB h rep 22 25\r\n${HDR}abc\r\n`);
    expect(await sub.waitFor("abc\r\n")).toBe(`HMSG h 5 rep 22 25\r\n${HDR}abc\r\n`);
  });

  it("a client that did not ask for headers gets a plain MSG with the body only", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    const pub = await client({ headers: true });
    sub.send("SUB h 5\r\n");
    await sub.sync();
    pub.send(`HPUB h 22 25\r\n${HDR}abc\r\n`);
    expect(await sub.waitFor("abc\r\n")).toBe("MSG h 5 3\r\nabc\r\n");
    expect(broker.stats()).toMatchObject({ inBytes: 25, outBytes: 3 });
  });

  it("headers-only message (empty body)", async () => {
    const { client } = await setup();
    const sub = await client({ headers: true });
    sub.send("SUB h 1\r\n");
    await sub.sync();
    sub.send(`HPUB h 22 22\r\n${HDR}\r\n`);
    expect(await sub.waitFor(/HMSG h 1 22 22\r\n[\s\S]*\r\n\r\n\r\n$/)).toBe(`HMSG h 1 22 22\r\n${HDR}\r\n`);
  });
});

describe("no responders", () => {
  it("a request nobody receives gets an immediate 503 status on the requester's inbox", async () => {
    const { client } = await setup();
    const req = await client({ headers: true, no_responders: true });
    req.send("SUB _INBOX.me.* 9\r\nPUB svc.none _INBOX.me.1 2\r\nhi\r\n");
    expect(await req.waitFor("503")).toBe("HMSG _INBOX.me.1 9 16 16\r\nNATS/1.0 503\r\n\r\n\r\n");
  });

  it("no 503 when somebody did receive it", async () => {
    const { client } = await setup();
    const svc = await client();
    const req = await client({ headers: true, no_responders: true });
    svc.send("SUB svc 1\r\n");
    await svc.sync();
    req.send("SUB _INBOX.me.* 9\r\nPUB svc _INBOX.me.1 2\r\nhi\r\n");
    await svc.waitFor("hi\r\n");
    await req.sync();
    expect(req.received).toBe("");
  });

  it("no 503 for a client that did not opt in (no_responders needs headers too)", async () => {
    const { client } = await setup();
    const a = await client({ no_responders: true });
    const b = await client({ headers: true });
    for (const r of [a, b]) {
      r.send("SUB _INBOX.me.* 9\r\nPUB nobody _INBOX.me.1 0\r\n\r\n");
      await r.sync();
      expect(r.received).toBe("");
    }
  });

  it("a plain PUB with no reply subject never gets a 503", async () => {
    const { client } = await setup();
    const r = await client({ headers: true, no_responders: true });
    r.send("PUB nobody 1\r\nx\r\n");
    await r.sync();
    expect(r.received).toBe("");
  });
});

describe("slow consumer protection", () => {
  it("a subscriber that stops reading is dropped once its queued bytes pass maxPending; others carry on", async () => {
    const { client, broker } = await setup({ maxPending: 64 * 1024 });
    const slow = await client();
    const healthy = await client();
    const pub = await client();
    slow.send("SUB firehose 1\r\n");
    healthy.send("SUB ctl 1\r\n");
    await Promise.all([slow.sync(), healthy.sync()]);
    slow.socket.pause(); // stop reading: the kernel buffers fill, then the server's write buffer grows

    const body = "x".repeat(8 * 1024);
    for (let i = 0; i < 4000 && broker.stats().slowConsumers === 0; i++) {
      pub.send(`PUB firehose ${body.length}\r\n${body}\r\n`);
      if (i % 100 === 99) await pub.sync();
    }
    await until(() => broker!.stats().slowConsumers === 1, 5000);
    expect(broker.stats()).toMatchObject({ connections: 2, subscriptions: 1 });

    // The publisher and the other subscriber are unaffected.
    pub.send("PUB ctl 2\r\nok\r\n");
    await healthy.waitFor("MSG ctl 1 2\r\nok\r\n");
  });

  it("a subscriber that keeps up is NOT dropped, even when the total sent is far above maxPending", async () => {
    const { client, broker } = await setup({ maxPending: 64 * 1024 });
    const sub = await client();
    const pub = await client();
    sub.send("SUB s 1\r\n");
    await sub.sync();
    const body = "y".repeat(1024);
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 50; i++) pub.send(`PUB s ${body.length}\r\n${body}\r\n`);
      await pub.sync();
      await sub.sync();
    }
    expect(count(sub.received, /MSG s 1 1024\r\n/g)).toBe(500);
    expect(broker.stats().slowConsumers).toBe(0);
  });
});

describe("graceful close", () => {
  it("messages already accepted are delivered before the connection closes", async () => {
    const { client, broker: b } = await setup();
    broker = undefined; // closed by the test itself
    const sub = await client();
    const pub = await client();
    sub.send("SUB g 1\r\n");
    await sub.sync();
    const body = "z".repeat(1024);
    for (let i = 0; i < 500; i++) pub.send(`PUB g ${body.length}\r\n${body}\r\n`);
    await pub.sync(); // the server has routed all 500 into sub's socket buffer
    expect(await b.close()).toBe("closed");
    await sub.waitClosed();
    expect(count(sub.received, /MSG g 1 1024\r\n/g)).toBe(500);
  });

  it("a peer that never closes its side is destroyed after forceMs", async () => {
    const { broker: b, port } = await setup();
    broker = undefined; // closed by the test itself
    const stubborn = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    stubborn.on("error", () => {});
    opened.push({ close: () => stubborn.destroy() });
    await new Promise((r) => stubborn.once("data", r)); // INFO
    const t0 = Date.now();
    expect(await b.close(300)).toBe("forced");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});
