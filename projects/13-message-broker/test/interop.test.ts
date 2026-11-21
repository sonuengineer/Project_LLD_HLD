/**
 * Interop with the OFFICIAL NATS client for Node (npm "nats", pinned in devDependencies). This is the independent
 * check: our own tests could share our own misunderstanding of the protocol, the official client cannot.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connect, headers, StringCodec, type NatsConnection } from "nats";
import type { Broker } from "../src/server.js";
import { startBroker, until } from "./helpers.js";

const sc = StringCodec();
let broker: Broker | undefined;
const conns: NatsConnection[] = [];

afterEach(async () => {
  for (const nc of conns.splice(0)) if (!nc.isClosed()) await nc.close();
  await broker?.close();
  broker = undefined;
});

async function setup(opts = {}) {
  const s = await startBroker(opts);
  broker = s.broker;
  const client = async () => {
    const nc = await connect({ servers: `127.0.0.1:${s.port}`, reconnect: false });
    conns.push(nc);
    return nc;
  };
  return { ...s, client };
}

/** Collects up to n messages from a subscription, or fails after ms. */
async function collect(sub: AsyncIterable<{ subject: string; data: Uint8Array }>, n: number, ms = 2000) {
  const got: Array<{ subject: string; text: string }> = [];
  const read = (async () => {
    for await (const m of sub) {
      got.push({ subject: m.subject, text: sc.decode(m.data) });
      if (got.length === n) break;
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`only ${got.length}/${n} messages`)), ms);
  });
  await Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  return got;
}

describe("official nats client against our broker", () => {
  it("connects and sees our INFO", async () => {
    const { client } = await setup();
    const nc = await client();
    expect(nc.info?.server_name).toBe("h12-broker");
    expect(nc.info?.headers).toBe(true);
  });

  it("publish and subscribe, with flush as a round trip", async () => {
    const { client } = await setup();
    const sub = await client();
    const pub = await client();
    const s = sub.subscribe("greet.*");
    await sub.flush();
    pub.publish("greet.ana", sc.encode("hola"));
    pub.publish("greet.bo", sc.encode("hej"));
    pub.publish("other", sc.encode("not me"));
    expect(await collect(s, 2)).toEqual([
      { subject: "greet.ana", text: "hola" },
      { subject: "greet.bo", text: "hej" },
    ]);
  });

  it("> wildcard and ordering from one publisher", async () => {
    const { client } = await setup();
    const sub = await client();
    const pub = await client();
    const s = sub.subscribe("log.>");
    await sub.flush();
    for (let i = 0; i < 100; i++) pub.publish(`log.app.${i % 3}`, sc.encode(String(i)));
    const got = await collect(s, 100);
    expect(got.map((m) => Number(m.text))).toEqual([...Array(100).keys()]);
  });

  it("request / reply through the client's _INBOX", async () => {
    const { client } = await setup();
    const svc = await client();
    const caller = await client();
    const s = svc.subscribe("math.double");
    (async () => {
      for await (const m of s) m.respond(sc.encode(String(Number(sc.decode(m.data)) * 2)));
    })();
    await svc.flush();
    const reply = await caller.request("math.double", sc.encode("21"), { timeout: 2000 });
    expect(sc.decode(reply.data)).toBe("42");
  });

  it("subscribe with max auto-unsubscribes on the server too", async () => {
    const { client, broker } = await setup();
    const sub = await client();
    const pub = await client();
    const s = sub.subscribe("t", { max: 2 });
    await sub.flush();
    expect(broker.stats().subscriptions).toBe(1);
    for (let i = 0; i < 5; i++) pub.publish("t", sc.encode(String(i)));
    const got = await collect(s, 2);
    expect(got.map((m) => m.text)).toEqual(["0", "1"]);
    await pub.flush();
    await sub.flush();
    expect(broker.stats().outMsgs).toBe(2);
  });

  it("unsubscribe removes the subscription on the server", async () => {
    const { client, broker } = await setup();
    const nc = await client();
    const before = broker.stats().subscriptions;
    const s = nc.subscribe("gone");
    await nc.flush();
    expect(broker.stats().subscriptions).toBe(before + 1);
    s.unsubscribe();
    await nc.flush();
    expect(broker.stats().subscriptions).toBe(before);
  });

  it("a payload close to max_payload goes through intact", async () => {
    const { client } = await setup({ maxPayload: 256 * 1024 });
    const sub = await client();
    const pub = await client();
    const s = sub.subscribe("big");
    await sub.flush();
    const body = new Uint8Array(256 * 1024 - 10).map((_, i) => (i * 31) & 0xff);
    pub.publish("big", body);
    for await (const m of s) {
      expect(Buffer.from(m.data).equals(Buffer.from(body))).toBe(true);
      break;
    }
  });

  it("the client refuses a payload over the server's max_payload (it read the limit from INFO)", async () => {
    const { client } = await setup({ maxPayload: 1000 });
    const nc = await client();
    expect(() => nc.publish("x", new Uint8Array(1001))).toThrow();
  });

  it("queue group across two connections: every message handled exactly once", async () => {
    const { client } = await setup();
    const w1 = await client();
    const w2 = await client();
    const pub = await client();
    const seen: string[] = [];
    const counts = [0, 0];
    [w1, w2].forEach((nc, i) => {
      const s = nc.subscribe("work", { queue: "pool" });
      (async () => {
        for await (const m of s) {
          seen.push(sc.decode(m.data));
          counts[i]!++;
        }
      })();
    });
    await w1.flush();
    await w2.flush();
    for (let i = 0; i < 100; i++) pub.publish("work", sc.encode(String(i)));
    await pub.flush();
    await until(() => seen.length >= 100);
    await w1.flush();
    await w2.flush();
    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100);
    expect(counts[0]! > 0 && counts[1]! > 0).toBe(true);
  });

  it("headers round trip", async () => {
    const { client } = await setup();
    const sub = await client();
    const pub = await client();
    const s = sub.subscribe("h");
    await sub.flush();
    const h = headers();
    h.set("Trace-Id", "abc-123");
    h.append("Tag", "one");
    h.append("Tag", "two");
    pub.publish("h", sc.encode("body"), { headers: h });
    for await (const m of s) {
      expect(m.headers?.get("Trace-Id")).toBe("abc-123");
      expect(m.headers?.values("Tag")).toEqual(["one", "two"]);
      expect(sc.decode(m.data)).toBe("body");
      break;
    }
  });

  it("a request to a subject nobody listens on fails at once with 503 instead of timing out", async () => {
    const { client } = await setup();
    const nc = await client();
    const t0 = Date.now();
    const err = await nc.request("nobody.home", sc.encode("?"), { timeout: 5000 }).catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe("503");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("drain and close leave no connections or subscriptions behind", async () => {
    const { client, broker } = await setup();
    const a = await client();
    const b = await client();
    a.subscribe("a.>");
    b.subscribe("b.*");
    await a.flush();
    await b.flush();
    expect(broker.stats().connections).toBe(2);
    await a.drain();
    await b.close();
    await until(() => broker!.stats().connections === 0);
    expect(broker.stats().subscriptions).toBe(0);
  });
});
