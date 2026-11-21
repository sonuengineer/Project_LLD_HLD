import { afterEach, describe, expect, it } from "vitest";
import type { Broker } from "../src/server.js";
import { Raw, startBroker, until } from "./helpers.js";

let broker: Broker | undefined;
const opened: Raw[] = [];
afterEach(async () => {
  for (const r of opened.splice(0)) r.close();
  await broker?.close();
  broker = undefined;
});

async function setup(opts = {}) {
  const s = await startBroker(opts);
  broker = s.broker;
  const client = async (connect: Record<string, unknown> = {}) => {
    const r = await Raw.ready(s.port, connect);
    opened.push(r);
    return r;
  };
  return { ...s, client };
}

describe("connect", () => {
  it("sends INFO first, with the fields clients rely on", async () => {
    const { port } = await setup({ maxPayload: 1234 });
    const r = await Raw.connect(port);
    opened.push(r);
    const text = await r.waitFor(/\r\n/);
    expect(text.startsWith("INFO ")).toBe(true);
    const info = JSON.parse(text.slice(5, text.indexOf("\r\n")));
    expect(info).toMatchObject({ proto: 1, headers: true, max_payload: 1234 });
    expect(typeof info.server_id).toBe("string");
    expect(typeof info.client_id).toBe("number");
  });

  it("answers PING with PONG", async () => {
    const { client } = await setup();
    const r = await client();
    r.send("PING\r\n");
    await r.waitFor("PONG\r\n");
  });
});

describe("publish and subscribe", () => {
  it("delivers a PUB to a subscriber as MSG with the subscriber's sid", async () => {
    const { client } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB greet.* 42\r\n");
    await sub.sync();
    pub.send("PUB greet.joe 5\r\nhello\r\n");
    expect(await sub.waitFor("hello\r\n")).toBe("MSG greet.joe 42 5\r\nhello\r\n");
  });

  it("carries the reply subject through", async () => {
    const { client } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB svc 1\r\n");
    await sub.sync();
    pub.send("PUB svc _INBOX.abc 2\r\nhi\r\n");
    expect(await sub.waitFor("hi\r\n")).toBe("MSG svc 1 _INBOX.abc 2\r\nhi\r\n");
  });

  it("fans out to every matching subscription, once per subscription", async () => {
    const { client } = await setup();
    const a = await client();
    const b = await client();
    const pub = await client();
    a.send("SUB x.y 1\r\nSUB x.* 2\r\n");
    b.send("SUB x.> 9\r\n");
    await a.sync();
    await b.sync();
    pub.send("PUB x.y 1\r\nZ\r\n");
    await a.waitFor(/MSG x\.y 1 1\r\nZ\r\n/);
    await a.waitFor(/MSG x\.y 2 1\r\nZ\r\n/);
    await b.waitFor("MSG x.y 9 1\r\nZ\r\n");
  });

  it("a message with no matching subscriber is simply dropped (at most once, nothing stored)", async () => {
    const { client, broker } = await setup();
    const pub = await client();
    pub.send("PUB nobody.home 3\r\nabc\r\n");
    await pub.sync();
    const sub = await client();
    sub.send("SUB nobody.home 1\r\n");
    await sub.sync();
    await pub.sync();
    expect(sub.received).toBe("");
    expect(broker.stats()).toMatchObject({ inMsgs: 1, outMsgs: 0 });
  });

  it("a binary payload with CRLF inside is delivered byte for byte", async () => {
    const { client } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB bin 1\r\n");
    await sub.sync();
    const body = Buffer.from([0, 13, 10, 255, 80, 73, 78, 71, 13, 10]);
    pub.send(Buffer.concat([Buffer.from(`PUB bin ${body.length}\r\n`), body, Buffer.from("\r\n")]));
    await sub.waitFor(/MSG bin 1 10\r\n[\s\S]{10}\r\n$/);
    expect(Buffer.from(sub.received, "latin1").subarray("MSG bin 1 10\r\n".length, -2).equals(body)).toBe(true);
  });

  it("echo:false stops a client receiving its own messages; default echo delivers them", async () => {
    const { client } = await setup();
    const quiet = await client({ echo: false });
    const loud = await client();
    quiet.send("SUB e 1\r\n");
    loud.send("SUB e 1\r\n");
    await quiet.sync();
    await loud.sync();
    quiet.send("PUB e 1\r\nq\r\n");
    loud.send("PUB e 1\r\nl\r\n");
    await loud.waitFor("MSG e 1 1\r\nl\r\n");
    await loud.waitFor("MSG e 1 1\r\nq\r\n");
    await quiet.waitFor("MSG e 1 1\r\nl\r\n");
    await quiet.sync();
    expect(quiet.received).not.toContain("\r\nq\r\n");
  });
});

describe("unsubscribe", () => {
  it("UNSUB stops delivery and removes the subscription", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB u 1\r\n");
    await sub.sync();
    expect(broker.stats().subscriptions).toBe(1);
    sub.send("UNSUB 1\r\n");
    await sub.sync();
    expect(broker.stats().subscriptions).toBe(0);
    pub.send("PUB u 1\r\nx\r\n");
    await pub.sync();
    await sub.sync();
    expect(sub.received).toBe("");
  });

  it("UNSUB <sid> <max> delivers exactly max more messages, then removes the subscription", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB m 1\r\nUNSUB 1 3\r\n");
    await sub.sync();
    for (let i = 0; i < 5; i++) pub.send(`PUB m 1\r\n${i}\r\n`);
    await pub.sync();
    await sub.sync();
    expect(sub.received.match(/MSG m 1 1\r\n/g)).toHaveLength(3);
    expect(sub.received).toContain("\r\n2\r\n");
    expect(sub.received).not.toContain("\r\n3\r\n");
    expect(broker.stats().subscriptions).toBe(0);
  });

  it("UNSUB with a max already reached removes it immediately", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB m 1\r\n");
    await sub.sync();
    pub.send("PUB m 1\r\na\r\nPUB m 1\r\nb\r\n");
    await pub.sync();
    sub.send("UNSUB 1 2\r\n");
    await sub.sync();
    expect(broker.stats().subscriptions).toBe(0);
  });

  it("UNSUB for an unknown sid is not an error", async () => {
    const { client } = await setup({});
    const r = await client({ verbose: true });
    r.send("UNSUB nope\r\n");
    await r.waitFor("+OK\r\n");
    expect(r.received).not.toContain("-ERR");
  });

  it("a repeated sid keeps the first subscription", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    const pub = await client();
    sub.send("SUB a 1\r\nSUB b 1\r\n");
    await sub.sync();
    expect(broker.stats().subscriptions).toBe(1);
    pub.send("PUB b 1\r\nx\r\nPUB a 1\r\ny\r\n");
    await sub.waitFor("MSG a 1 1\r\ny\r\n");
    expect(sub.received).not.toContain("MSG b");
  });

  it("a disconnect removes all of that client's subscriptions", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    sub.send("SUB a 1\r\nSUB b.* 2\r\nSUB > 3\r\n");
    await sub.sync();
    expect(broker.stats()).toMatchObject({ connections: 1, subscriptions: 3 });
    sub.close();
    await until(() => broker!.stats().connections === 0);
    expect(broker.stats().subscriptions).toBe(0);
  });
});

describe("verbose mode", () => {
  it("+OK after CONNECT, SUB, PUB and UNSUB; nothing extra after PING", async () => {
    const { port } = await setup();
    const r = await Raw.connect(port);
    opened.push(r);
    await r.waitFor(/\r\n/);
    r.received = "";
    r.send('CONNECT {"verbose":true}\r\nSUB a 1\r\nPUB a 1\r\nx\r\nUNSUB 1\r\nPING\r\n');
    await r.waitFor("PONG\r\n");
    // CONNECT, SUB, (MSG to self), PUB, UNSUB, PONG
    expect(r.received).toBe("+OK\r\n+OK\r\nMSG a 1 1\r\nx\r\n+OK\r\n+OK\r\nPONG\r\n");
  });

  it("non-verbose clients get no +OK", async () => {
    const { client } = await setup();
    const r = await client();
    r.send("SUB a 1\r\nUNSUB 1\r\n");
    await r.sync();
    expect(r.received).toBe("");
  });
});

describe("errors that keep the connection open", () => {
  it.each([
    ["SUB with an invalid subject", "SUB a..b 1\r\n", "Invalid Subject"],
    ["SUB with an invalid queue name", "SUB jobs wor.kers 1\r\n", "Invalid Queue Name"],
    ["PUB to a wildcard subject", "PUB a.* 1\r\nx\r\n", "Invalid Publish Subject"],
    ["PUB with a wildcard reply subject", "PUB a r.> 1\r\nx\r\n", "Invalid Publish Subject"],
  ])("%s", async (_name, input, message) => {
    const { client, broker } = await setup();
    const r = await client();
    r.send(input);
    await r.waitFor(`-ERR '${message}'\r\n`);
    r.send("PING\r\n");
    await r.waitFor("PONG\r\n");
    expect(r.closed).toBe(false);
    expect(broker.stats().subscriptions).toBe(0);
  });
});

describe("errors that close the connection", () => {
  it.each([
    ["unknown operation", "FOO\r\n", "Unknown Protocol Operation"],
    ["payload over max_payload", "PUB a 2000\r\n", "Maximum Payload Violation"],
    ["control line too long", "SUB " + "a".repeat(5000), "Maximum Control Line Exceeded"],
    ["bad CONNECT", "CONNECT {\r\n", "Invalid CONNECT: bad JSON"],
  ])("%s", async (_name, input, message) => {
    const { client, broker } = await setup({ maxPayload: 1000 });
    const r = await client();
    r.send("SUB keep.me 1\r\n");
    await r.sync();
    r.send(input);
    await r.waitFor(`-ERR '${message}'\r\n`);
    await r.waitClosed();
    expect(broker.stats()).toMatchObject({ connections: 0, subscriptions: 0 });
  });

  it("one bad client does not affect another", async () => {
    const { client } = await setup();
    const good = await client();
    const bad = await client();
    good.send("SUB a 1\r\n");
    await good.sync();
    bad.send("BOOM\r\n");
    await bad.waitClosed();
    const pub = await client();
    pub.send("PUB a 2\r\nok\r\n");
    await good.waitFor("MSG a 1 2\r\nok\r\n");
  });
});

describe("liveness: server PINGs, client must PONG", () => {
  it("a client that answers PONG stays connected", async () => {
    const { client } = await setup({ pingIntervalMs: 50, maxPingsOut: 2 });
    const r = await client();
    for (let i = 0; i < 4; i++) {
      await r.waitFor("PING\r\n");
      r.received = "";
      r.send("PONG\r\n");
    }
    expect(r.closed).toBe(false);
  });

  it("a client that never answers is dropped as a stale connection after maxPingsOut unanswered PINGs", async () => {
    const { client, broker } = await setup({ pingIntervalMs: 50, maxPingsOut: 2 });
    const r = await client();
    r.send("SUB a 1\r\n");
    await r.sync();
    await r.waitFor("-ERR 'Stale Connection'\r\n", 3000);
    expect(r.received.match(/PING\r\n/g)).toHaveLength(2);
    await r.waitClosed();
    expect(broker.stats()).toMatchObject({ connections: 0, subscriptions: 0 });
  });
});

describe("stats and shutdown", () => {
  it("counts messages and payload bytes in and out", async () => {
    const { client, broker } = await setup();
    const a = await client();
    const b = await client();
    a.send("SUB s 1\r\n");
    b.send("SUB s 1\r\n");
    await a.sync();
    await b.sync();
    const pub = await client();
    pub.send("PUB s 4\r\nabcd\r\n");
    await a.waitFor("abcd");
    await b.waitFor("abcd");
    expect(broker.stats()).toMatchObject({ inMsgs: 1, inBytes: 4, outMsgs: 2, outBytes: 8 });
  });

  it("close() drops every connection", async () => {
    const { client } = await setup();
    const r = await client();
    await broker!.close();
    broker = undefined;
    await r.waitClosed();
  });
});
