/**
 * Stage 3: several brokers in ONE test process, each on its own ephemeral client port and cluster port, connected by
 * real TCP routes over loopback. Every broker dials every other one, so the duplicate-connection rule is exercised in
 * every test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connect, StringCodec, type NatsConnection } from "nats";
import { Broker } from "../src/server.js";
import { Raw, until } from "./helpers.js";

const sc = StringCodec();
let brokers: Broker[] = [];
const opened: Array<{ close(): unknown }> = [];

afterEach(async () => {
  for (const r of opened.splice(0)) await r.close();
  await Promise.all(brokers.map((b) => b.close(500)));
  brokers = [];
});

interface Node {
  broker: Broker;
  port: number;
  clusterPort: number;
}

async function startNode(clusterPort = 0): Promise<Node> {
  const broker = new Broker({ host: "127.0.0.1", port: 0, cluster: { port: clusterPort, reconnectMs: 50 } });
  const a = await broker.listen();
  brokers.push(broker);
  return { broker, port: a.port, clusterPort: a.clusterPort! };
}

async function startCluster(n: number): Promise<Node[]> {
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) nodes.push(await startNode());
  for (const a of nodes) for (const b of nodes) if (a !== b) a.broker.addRoute(`127.0.0.1:${b.clusterPort}`);
  await until(() => nodes.every((x) => x.broker.stats().routes === n - 1), 5000);
  return nodes;
}

async function raw(node: Node, connectOpts: Record<string, unknown> = {}): Promise<Raw> {
  const r = await Raw.ready(node.port, connectOpts);
  opened.push(r);
  return r;
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe("mesh formation", () => {
  it("three brokers that all dial each other end with exactly one route per pair, and it stays that way", async () => {
    const nodes = await startCluster(3);
    const ids = nodes.map((n) => n.broker.serverId).sort();
    for (const n of nodes) expect(n.broker.routePeers()).toEqual(ids.filter((id) => id !== n.broker.serverId));
    await new Promise((r) => setTimeout(r, 300)); // several re-dial intervals: no flapping
    for (const n of nodes) expect(n.broker.stats().routes).toBe(2);
  });

  it("a broker told to dial its own cluster port does not create a route and does not keep trying", async () => {
    const n = await startNode();
    n.broker.addRoute(`127.0.0.1:${n.clusterPort}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(n.broker.stats().routes).toBe(0);
  });
});

describe("interest propagation and forwarding", () => {
  it("a message published on A reaches a subscriber on B exactly once", async () => {
    const [a, b] = await startCluster(2);
    const sub = await raw(b!);
    sub.send("SUB greet.* 1\r\n");
    await sub.sync();
    await until(() => a!.broker.hasRemoteInterest("greet.x"));
    const pub = await raw(a!);
    pub.send("PUB greet.x 2\r\nhi\r\n");
    await sub.waitFor("MSG greet.x 1 2\r\nhi\r\n");
    await pub.sync();
    await sub.sync();
    expect(count(sub.received, /MSG greet/g)).toBe(1);
  });

  it("nothing is forwarded to a broker that has no interest", async () => {
    const [a, b, c] = await startCluster(3);
    const sub = await raw(b!);
    sub.send("SUB only.b 1\r\n");
    await sub.sync();
    await until(() => a!.broker.hasRemoteInterest("only.b"));
    const pub = await raw(a!);
    for (let i = 0; i < 20; i++) pub.send("PUB only.b 1\r\nx\r\n");
    await pub.sync();
    await until(() => count(sub.received, /MSG only\.b/g) === 20);
    expect(a!.broker.stats().routeOutMsgs).toBe(20);
    expect(c!.broker.stats().routeInMsgs).toBe(0);
  });

  it("no duplicates in a full mesh, and a broker never forwards what came from a route", async () => {
    const [a, b, c] = await startCluster(3);
    const subs = await Promise.all([raw(a!), raw(b!), raw(c!)]);
    for (const s of subs) s.send("SUB news 1\r\n");
    await Promise.all(subs.map((s) => s.sync()));
    await until(() => a!.broker.peerInterest("news") === 2);
    const pub = await raw(a!);
    for (let i = 0; i < 100; i++) pub.send(`PUB news 1\r\n${i % 10}\r\n`);
    await pub.sync();
    await until(() => subs.every((s) => count(s.received, /MSG news/g) >= 100), 5000);
    await new Promise((r) => setTimeout(r, 100));
    for (const s of subs) expect(count(s.received, /MSG news/g)).toBe(100);
    expect(a!.broker.stats().routeOutMsgs).toBe(200);
    expect(b!.broker.stats().routeOutMsgs).toBe(0);
    expect(c!.broker.stats().routeOutMsgs).toBe(0);
  });

  it("interest is counted: it is withdrawn only when the LAST local subscription goes, including on disconnect", async () => {
    const [a, b] = await startCluster(2);
    const s1 = await raw(b!);
    const s2 = await raw(b!);
    s1.send("SUB t 1\r\n");
    s2.send("SUB t 1\r\n");
    await Promise.all([s1.sync(), s2.sync()]);
    await until(() => a!.broker.hasRemoteInterest("t"));
    s1.send("UNSUB 1\r\n");
    await s1.sync();
    await new Promise((r) => setTimeout(r, 100));
    expect(a!.broker.hasRemoteInterest("t")).toBe(true);
    expect(a!.broker.stats().remoteInterest).toBe(1); // two subscriptions on B, ONE announced interest
    s2.close(); // disconnect, not UNSUB
    await until(() => !a!.broker.hasRemoteInterest("t"));
    expect(a!.broker.stats().remoteInterest).toBe(0);
  });

  it("wildcard interest is matched on the sending side", async () => {
    const [a, b] = await startCluster(2);
    const sub = await raw(b!);
    sub.send("SUB orders.> 1\r\n");
    await sub.sync();
    await until(() => a!.broker.hasRemoteInterest("orders.eu.created"));
    expect(a!.broker.hasRemoteInterest("orders")).toBe(false);
    const pub = await raw(a!);
    pub.send("PUB orders.eu.created 1\r\nx\r\n");
    await sub.waitFor("MSG orders.eu.created 1 1\r\nx\r\n");
  });

  it("a broker that joins later learns the existing interest", async () => {
    const [a] = await startCluster(1);
    const sub = await raw(a!);
    sub.send("SUB early 1\r\n");
    await sub.sync();
    const late = await startNode();
    late.broker.addRoute(`127.0.0.1:${a!.clusterPort}`);
    await until(() => late.broker.hasRemoteInterest("early"));
    const pub = await raw(late);
    pub.send("PUB early 1\r\nx\r\n");
    await sub.waitFor("MSG early 1 1\r\nx\r\n");
  });

  it("headers survive the route hop", async () => {
    const [a, b] = await startCluster(2);
    const sub = await raw(b!, { headers: true });
    sub.send("SUB h 1\r\n");
    await sub.sync();
    await until(() => a!.broker.hasRemoteInterest("h"));
    const pub = await raw(a!, { headers: true });
    const hdr = "NATS/1.0\r\nK: v\r\n\r\n"; // 18 bytes
    pub.send(`HPUB h r.x 18 20\r\n${hdr}ok\r\n`);
    expect(await sub.waitFor("ok\r\n")).toBe(`HMSG h 1 r.x 18 20\r\n${hdr}ok\r\n`);
  });
});

describe("queue groups across the cluster", () => {
  it("a local member is preferred: nothing crosses a route for the group", async () => {
    const [a, b, c] = await startCluster(3);
    const members = await Promise.all([raw(a!), raw(b!), raw(c!)]);
    for (const m of members) m.send("SUB jobs w 1\r\n");
    await Promise.all(members.map((m) => m.sync()));
    await until(() => a!.broker.peerInterest("jobs", "w") === 2);
    const pub = await raw(a!);
    for (let i = 0; i < 100; i++) pub.send("PUB jobs 1\r\nx\r\n");
    await pub.sync();
    await members[0]!.sync();
    expect(count(members[0]!.received, /MSG jobs/g)).toBe(100);
    expect(a!.broker.stats().routeOutMsgs).toBe(0);
  });

  it("with no local member, each message goes to exactly ONE remote member in the whole cluster", async () => {
    const [a, b, c] = await startCluster(3);
    const mb = await raw(b!);
    const mc = await raw(c!);
    mb.send("SUB jobs w 1\r\n");
    mc.send("SUB jobs w 1\r\n");
    await Promise.all([mb.sync(), mc.sync()]);
    await until(() => a!.broker.peerInterest("jobs", "w") === 2);
    const pub = await raw(a!);
    for (let i = 0; i < 200; i++) pub.send("PUB jobs 1\r\nx\r\n");
    await pub.sync();
    await until(() => count(mb.received, /MSG jobs/g) + count(mc.received, /MSG jobs/g) >= 200, 5000);
    await new Promise((r) => setTimeout(r, 100));
    const nb = count(mb.received, /MSG jobs/g);
    const nc = count(mc.received, /MSG jobs/g);
    expect(nb + nc).toBe(200);
    expect(nb).toBeGreaterThan(0);
    expect(nc).toBeGreaterThan(0);
  });

  it("plain subscribers and a queue group on the same peer: one RMSG carries both", async () => {
    const [a, b, c] = await startCluster(3);
    const plainB = await raw(b!);
    const qB = await raw(b!);
    const qC = await raw(c!);
    plainB.send("SUB ev 1\r\n");
    qB.send("SUB ev g 1\r\n");
    qC.send("SUB ev g 1\r\n");
    await Promise.all([plainB.sync(), qB.sync(), qC.sync()]);
    await until(() => a!.broker.peerInterest("ev", "g") === 2 && a!.broker.peerInterest("ev") === 1);
    const pub = await raw(a!);
    for (let i = 0; i < 100; i++) pub.send("PUB ev 1\r\nx\r\n");
    await pub.sync();
    await until(() => count(plainB.received, /MSG ev/g) >= 100, 5000);
    await until(() => count(qB.received, /MSG ev/g) + count(qC.received, /MSG ev/g) >= 100, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(count(plainB.received, /MSG ev/g)).toBe(100);
    expect(count(qB.received, /MSG ev/g) + count(qC.received, /MSG ev/g)).toBe(100);
    // B always gets a copy (plain); C only when it was picked for the group: never more than 1 RMSG per peer per message
    expect(a!.broker.stats().routeOutMsgs).toBe(100 + count(qC.received, /MSG ev/g));
  });
});

describe("failure and recovery", () => {
  it("a broker that restarts on the same cluster port is re-dialled and gets the interest again", async () => {
    const a = await startNode();
    const b = await startNode();
    a.broker.addRoute(`127.0.0.1:${b.clusterPort}`);
    await until(() => a.broker.stats().routes === 1);
    const sub = await raw(a);
    sub.send("SUB back 1\r\n");
    await sub.sync();

    await b.broker.close(200);
    brokers = brokers.filter((x) => x !== b.broker);
    await until(() => a.broker.stats().routes === 0);

    const b2 = await startNode(b.clusterPort); // same port, new server id; only A knows the address
    await until(() => a.broker.stats().routes === 1 && b2.broker.hasRemoteInterest("back"), 5000);
    const pub = await raw(b2);
    pub.send("PUB back 2\r\nok\r\n");
    await sub.waitFor("MSG back 1 2\r\nok\r\n");
  });

  it("request/reply across brokers with the official client (reply travels back over the route)", async () => {
    const [a, b] = await startCluster(2);
    const svc = await connect({ servers: `127.0.0.1:${b!.port}`, reconnect: false });
    const caller = await connect({ servers: `127.0.0.1:${a!.port}`, reconnect: false });
    opened.push(svc, caller);
    const s = svc.subscribe("math.double");
    (async () => {
      for await (const m of s) m.respond(sc.encode(String(Number(sc.decode(m.data)) * 2)));
    })();
    await svc.flush();
    await until(() => a!.broker.hasRemoteInterest("math.double"));
    const reply = await caller.request("math.double", sc.encode("21"), { timeout: 2000 });
    expect(sc.decode(reply.data)).toBe("42");
  });

  it("a client with a server list fails over when its broker dies, resubscribes, and keeps receiving", async () => {
    const [a, b, c] = await startCluster(3);
    const nc: NatsConnection = await connect({
      servers: [`127.0.0.1:${a!.port}`, `127.0.0.1:${b!.port}`],
      noRandomize: true,
      reconnectTimeWait: 50,
      maxReconnectAttempts: 20,
    });
    opened.push(nc);
    const got: string[] = [];
    const s = nc.subscribe("fo");
    (async () => {
      for await (const m of s) got.push(sc.decode(m.data));
    })();
    await nc.flush();
    await until(() => c!.broker.hasRemoteInterest("fo"));
    const pub = await raw(c!);
    pub.send("PUB fo 6\r\nbefore\r\n");
    await until(() => got.includes("before"));

    await a!.broker.close(200); // the client's broker dies
    brokers = brokers.filter((x) => x !== a!.broker);
    await until(() => b!.broker.stats().connections === 1, 5000); // reconnected to B
    await until(() => c!.broker.peerInterest("fo") === 1, 5000); // and re-subscribed there
    pub.send("PUB fo 5\r\nafter\r\n");
    await until(() => got.includes("after"), 5000);
    expect(got).toEqual(["before", "after"]);
  });
});
