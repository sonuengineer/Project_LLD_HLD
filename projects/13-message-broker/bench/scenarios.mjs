// Experiments B1-B7 (planned in ../PLAN.md). Each returns { title, note, columns, rows, raw }.
// Every number in a table comes from the `raw` data saved next to it.
import { connect as natsConnect, StringCodec } from "nats";
import { BenchClient, waitUntil } from "./client.mjs";
import {
  QUICK, RUNS, cell, cluster3, median, percentile, remoteNodes, round, rssKiB, sleep, startBroker, startNatsServer, stopAll,
} from "./lib.mjs";

const PAYLOAD = Buffer.alloc(128, "x");
const now = () => performance.now();

/**
 * Wait until every subscriber's interest is known where the publisher is connected: each subscriber client subscribes a
 * probe subject AFTER its real subscriptions; the publisher repeats a probe until all probes arrived. Interest messages
 * travel in order on one route, so the earlier subscriptions are known too.
 */
async function ready(pub, subs, tag = "p") {
  const got = new Set();
  subs.forEach((s, i) => s.sub(`_bench.probe.${tag}.${i}`, () => got.add(i)));
  await Promise.all(subs.map((s) => s.flush()));
  const end = Date.now() + 15_000;
  while (got.size < subs.length) {
    if (Date.now() > end) throw new Error(`probe: only ${got.size}/${subs.length} subscribers reachable`);
    subs.forEach((_, i) => got.has(i) || pub.pub(`_bench.probe.${tag}.${i}`, Buffer.from("probe")));
    await pub.flush();
    await sleep(20);
  }
}

/** Publish `count` messages as fast as the socket accepts them. */
async function blast(pub, subject, count, payload = PAYLOAD) {
  for (let i = 0; i < count; i++) {
    pub.pub(subject, payload);
    if (i % 1000 === 999) await pub.drained();
  }
  await pub.flush();
}

const peakRss = (node) => {
  const s = node.stats?.() ?? [];
  return s.length ? Math.max(...s.map((x) => x.rssKiB)) : null;
};

// ------------------------------------------------------------------------------------------------ B1 / B2: fan-out

async function fanoutRun(target, n, total) {
  const m = Math.max(1000, Math.round(total / n));
  const subs = [];
  for (let i = 0; i < n; i++) subs.push(await BenchClient.connect(target.host, target.port));
  let got = 0;
  for (const s of subs) s.sub("fan", () => got++);
  const pub = await BenchClient.connect(target.host, target.port);
  await ready(pub, subs, "fan");
  const t0 = now();
  await blast(pub, "fan", m);
  const tPub = now();
  let complete = true;
  try {
    await waitUntil(() => got >= m * n, 60_000, "all deliveries");
  } catch {
    complete = false;
  }
  const t1 = now();
  const errors = subs.flatMap((s) => s.errors).concat(pub.errors);
  for (const c of [...subs, pub]) c.close();
  return {
    subscribers: n, messages: m, delivered: got, expected: m * n, complete, errors,
    publishSeconds: (tPub - t0) / 1000, totalSeconds: (t1 - t0) / 1000,
    publishedPerSec: m / ((t1 - t0) / 1000), deliveredPerSec: got / ((t1 - t0) / 1000),
  };
}

async function fanout(kind) {
  const total = QUICK ? 100_000 : 1_000_000;
  const ns = kind === "ours" ? [1, 10, 100] : [1, 10];
  const raw = [];
  for (const n of ns) {
    for (let r = 0; r < RUNS; r++) {
      const target = kind === "nats-server" ? await startNatsServer() : await startBroker();
      if (!target) return null;
      try {
        raw.push({ ...(await fanoutRun(target, n, total)), run: r, peakRssKiB: peakRss(target) });
      } finally {
        await target.stop();
      }
    }
  }
  return raw;
}

const fanoutRows = (raw) =>
  [...new Set(raw.map((x) => x.subscribers))].map((n) => {
    const rs = raw.filter((x) => x.subscribers === n);
    return [
      n,
      rs[0].messages,
      cell(rs.map((x) => x.publishedPerSec)),
      cell(rs.map((x) => x.deliveredPerSec)),
      rs.every((x) => x.complete && x.delivered === x.expected) ? "all" : `INCOMPLETE ${rs.map((x) => x.delivered).join("/")}`,
      rs.flatMap((x) => x.errors).length,
      cell(rs.map((x) => (x.peakRssKiB === null ? null : x.peakRssKiB / 1024))),
    ];
  });

const FANOUT_COLUMNS = ["subscribers", "messages per run", "published msg/s", "delivered msg/s", "delivered", "-ERR seen", "broker peak RSS MiB"];

async function b1() {
  const raw = await fanout("ours");
  return {
    title: "B1 Fan-out on one broker: 128-byte messages, 1 publisher, N subscribers",
    note: `Median of ${RUNS} run(s), min-max in brackets. Rates are measured from the first publish until the LAST subscriber had every message. The publisher and all subscribers live in ONE load-generator process, so at high rates the generator itself may be the limit -- B2 runs the same generator against nats-server to show where that limit is.`,
    columns: FANOUT_COLUMNS,
    rows: fanoutRows(raw),
    raw,
  };
}

// ------------------------------------------------------------------------------------------------ RTT helper (B2, B3)

async function rtt(requesterNode, responderNode, count) {
  const responder = await BenchClient.connect(responderNode.host, responderNode.port);
  responder.sub("rtt", (_s, reply, payload) => {
    responder.pub(reply, payload);
    responder.flushOut();
  });
  const req = await BenchClient.connect(requesterNode.host, requesterNode.port);
  let waiting = null;
  req.sub("_bench.rtt.*", () => waiting?.());
  await ready(req, [responder], "rtt-a"); // responder's interest is known at the requester's broker
  await ready(responder, [req], "rtt-b"); // and the requester's inbox at the responder's broker
  const samples = [];
  const warm = Math.min(200, count / 10);
  for (let i = 0; i < count + warm; i++) {
    const t0 = now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("rtt request timed out")), 5000);
      waiting = () => {
        clearTimeout(timer);
        resolve();
      };
      req.pub("rtt", PAYLOAD, `_bench.rtt.${i}`);
      req.flushOut();
    });
    if (i >= warm) samples.push(now() - t0);
  }
  req.close();
  responder.close();
  const s = samples.sort((a, b) => a - b);
  return { count: s.length, p50: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), max: s.at(-1) };
}

const rttRow = (label, rs) => [label, rs[0]?.count, cell(rs.map((x) => x.p50 * 1000)), cell(rs.map((x) => x.p90 * 1000)), cell(rs.map((x) => x.p99 * 1000))];
const RTT_COLUMNS = ["path", "requests per run", "p50 us", "p90 us", "p99 us"];

async function b2() {
  if (!process.env.NATS_SERVER_BIN) return { skipped: "NATS_SERVER_BIN is not set (path to the official nats-server binary)" };
  const ref = await fanout("nats-server");
  const ours = await fanout("ours-small");
  const count = QUICK ? 300 : 3000;
  const rttRaw = { ours: [], natsServer: [] };
  for (let r = 0; r < RUNS; r++) {
    const a = await startBroker();
    rttRaw.ours.push(await rtt(a, a, count));
    await a.stop();
    const b = await startNatsServer();
    rttRaw.natsServer.push(await rtt(b, b, count));
    await b.stop();
  }
  const rows = [];
  for (const n of [1, 10]) {
    const o = ours.filter((x) => x.subscribers === n);
    const t = ref.filter((x) => x.subscribers === n);
    rows.push([`fan-out, ${n} subscriber(s): delivered msg/s`, cell(o.map((x) => x.deliveredPerSec)), cell(t.map((x) => x.deliveredPerSec))]);
  }
  rows.push(["request/reply on one broker: p50 us", cell(rttRaw.ours.map((x) => x.p50 * 1000)), cell(rttRaw.natsServer.map((x) => x.p50 * 1000))]);
  rows.push(["request/reply on one broker: p99 us", cell(rttRaw.ours.map((x) => x.p99 * 1000)), cell(rttRaw.natsServer.map((x) => x.p99 * 1000))]);
  return {
    title: "B2 Reference point: the same load generator against the real nats-server",
    note: `Median of ${RUNS} run(s). Same machine, same client, same message size. nats-server is written in Go and multi-threaded; ours is one Node.js event loop. If both give a similar number, the load generator is the limit, not the broker.`,
    columns: ["measurement", "ours", "nats-server"],
    rows,
    raw: { natsServerVersionFrom: process.env.NATS_SERVER_BIN, fanout: { ours, natsServer: ref }, rtt: rttRaw },
  };
}

// ------------------------------------------------------------------------------------------------ B3: one route hop

async function b3() {
  const count = QUICK ? 300 : 3000;
  const raw = { sameNode: [], crossNode: [] };
  for (let r = 0; r < RUNS; r++) {
    const nodes = await cluster3();
    try {
      raw.sameNode.push(await rtt(nodes[0], nodes[0], count));
      raw.crossNode.push(await rtt(nodes[0], nodes[1], count));
    } finally {
      await stopAll(nodes);
    }
  }
  return {
    title: "B3 Request/reply latency: same broker vs across one route hop",
    note: `${RUNS} run(s), median with min-max. One request at a time (no pipelining); each round trip is timed on the requester's clock, so no clocks need to agree. Cross-node = request goes A -> B over the route and the reply comes back B -> A, so it contains TWO hops. ${remoteNodes().length ? "Remote brokers on other servers." : "Single host: the route hop is loopback, so this shows the broker's own cost of a hop, not network latency."}`,
    columns: RTT_COLUMNS,
    rows: [rttRow("requester and responder on the same broker", raw.sameNode), rttRow("responder on another broker (2 route hops per round trip)", raw.crossNode)],
    raw,
  };
}

// ------------------------------------------------------------------------------------------------ B4: kill a node

async function b4() {
  const sc = StringCodec();
  const seconds = QUICK ? 6 : 12;
  const killAt = QUICK ? 2000 : 4000;
  const ratePerSec = 2000;
  const raw = [];
  for (let r = 0; r < RUNS; r++) {
    const nodes = await cluster3();
    const [victim, survivor, pubNode] = nodes;
    const nc = await natsConnect({
      servers: [`${victim.host}:${victim.port}`, `${survivor.host}:${survivor.port}`],
      noRandomize: true,
      reconnectTimeWait: 100,
      maxReconnectAttempts: -1,
    });
    const seen = new Map();
    let tKill = null;
    let tFirstAfter = null;
    let tReconnect = null;
    (async () => {
      for await (const s of nc.status()) if (s.type === "reconnect" && tReconnect === null) tReconnect = now();
    })();
    const sub = nc.subscribe("seq");
    (async () => {
      for await (const m of sub) {
        const n = Number(sc.decode(m.data));
        seen.set(n, (seen.get(n) ?? 0) + 1);
        if (tKill !== null && tFirstAfter === null) tFirstAfter = now();
      }
    })();
    await nc.flush();
    const pub = await BenchClient.connect(pubNode.host, pubNode.port);
    // readiness: the subscriber's interest must be known at the publisher's broker (same probe idea as ready())
    const probe = nc.subscribe("_bench.probe.b4");
    let probed = false;
    (async () => {
      for await (const _ of probe) probed = true;
    })();
    await nc.flush();
    while (!probed) {
      pub.pub("_bench.probe.b4", Buffer.from("p"));
      await pub.flush();
      await sleep(20);
    }

    let sent = 0;
    const t0 = now();
    const perTick = ratePerSec / 100;
    const ticker = setInterval(() => {
      for (let i = 0; i < perTick; i++) pub.pub("seq", Buffer.from(String(sent++)));
      pub.flushOut();
    }, 10);
    await sleep(killAt);
    tKill = now();
    victim.proc.kill("SIGKILL"); // no warning, no graceful close
    await sleep(seconds * 1000 - killAt);
    clearInterval(ticker);
    await pub.flush();
    await sleep(2000);
    const sentAtKill = Math.round(((tKill - t0) / 1000) * ratePerSec);
    const received = seen.size;
    const dups = [...seen.values()].filter((c) => c > 1).length;
    const missing = [];
    for (let i = 0; i < sent; i++) if (!seen.has(i)) missing.push(i);
    raw.push({
      run: r, sent, received, lost: sent - received, duplicates: dups, approxSentAtKill: sentAtKill,
      firstMissing: missing[0] ?? null, lastMissing: missing.at(-1) ?? null,
      msKillToReconnect: tReconnect === null ? null : tReconnect - tKill,
      msKillToFirstMessage: tFirstAfter === null ? null : tFirstAfter - tKill,
    });
    await nc.close();
    pub.close();
    await stopAll(nodes);
  }
  return {
    title: "B4 Kill the subscriber's broker under load (SIGKILL, no warning)",
    note: `${RUNS} run(s). Publisher on broker C sends ${ratePerSec} msg/s with sequence numbers; the subscriber (official nats client, server list [A, B]) is on broker A, which is SIGKILLed after ${killAt / 1000} s. Delivery is AT MOST ONCE, so loss is expected; the point is how much and for how long. "Lost" = sequence numbers never received.`,
    columns: ["run", "sent", "received", "lost", "duplicates", "kill -> client reconnected (ms)", "kill -> first message again (ms)"],
    rows: raw.map((x) => [x.run + 1, x.sent, x.received, x.lost, x.duplicates, round(x.msKillToReconnect, 0), round(x.msKillToFirstMessage, 0)]),
    raw,
  };
}

// ------------------------------------------------------------------------------------------------ B5: slow consumer

async function b5() {
  const MiB = 1024 * 1024;
  const limit = QUICK ? 5000 : 20_000;
  const variants = [8 * MiB, 64 * MiB, 512 * MiB];
  const body = Buffer.alloc(1024, "s");
  const raw = [];
  for (const maxPending of variants) {
    const b = await startBroker({ env: { MAX_PENDING: String(maxPending), STATS_INTERVAL_MS: "100" } });
    try {
      const slow = await BenchClient.connect(b.host, b.port);
      slow.sub("flood");
      const pub = await BenchClient.connect(b.host, b.port);
      await ready(pub, [slow], "b5");
      await sleep(300);
      const baseline = rssKiB(b.proc.pid) ?? b.stats().at(-1)?.rssKiB ?? null;
      slow.socket.pause(); // stop reading
      const samples = [];
      const sampler = setInterval(() => samples.push({ t: now(), rss: rssKiB(b.proc.pid) }), 100);
      const t0 = now();
      let published = 0;
      // The drop is read from the BROKER's counter: a paused socket does not notice that the server closed it, so
      // waiting for the client side to see "close" would wait forever (that was a bug in the first version of B5).
      const dropped = () => (b.stats().at(-1)?.slowConsumers ?? 0) > 0;
      while (!dropped() && now() - t0 < limit) {
        for (let i = 0; i < 1000; i++) pub.pub("flood", body);
        published += 1000;
        await pub.drained();
        await pub.flush();
      }
      const tEnd = now();
      await sleep(2000);
      clearInterval(sampler);
      const statsLine = b.stats().at(-1);
      const fromProc = samples.some((s) => s.rss !== null);
      const series = fromProc ? samples.map((s) => s.rss) : b.stats().map((s) => s.rssKiB);
      raw.push({
        maxPending, dropped: dropped(), msToDrop: dropped() ? tEnd - t0 : null, publishedMessages: published,
        publishedMiB: (published * body.length) / MiB, baselineRssKiB: baseline,
        peakRssKiB: Math.max(...series.filter((x) => x !== null)), rssAfterKiB: series.filter((x) => x !== null).at(-1),
        slowConsumers: statsLine?.slowConsumers, rssSource: fromProc ? "/proc" : "stats line", samples: series,
      });
      pub.close();
      slow.close();
    } finally {
      await b.stop();
    }
  }
  return {
    title: "B5 Slow consumer: a subscriber stops reading while 1 KiB messages are published as fast as possible",
    note: `One run per limit, each stops after ${limit / 1000} s if nothing was dropped. RSS = the broker's resident memory. The kernel's socket buffers hold some bytes before the broker's own queue starts growing, so a drop happens somewhat after maxPending bytes were sent. The drop is detected from the broker's stats line (every 100 ms), so "ms until drop" is accurate to about 100 ms.`,
    columns: ["maxPending MiB", "dropped?", "ms until drop", "MiB published by then", "RSS before MiB", "peak RSS MiB", "RSS 2 s later MiB"],
    rows: raw.map((x) => [x.maxPending / MiB, x.dropped ? "yes" : "NO", round(x.msToDrop, 0), round(x.publishedMiB, 0), round(x.baselineRssKiB / 1024, 0), round(x.peakRssKiB / 1024, 0), round(x.rssAfterKiB / 1024, 0)]),
    raw,
  };
}

// ------------------------------------------------------------------------------------------------ B6: queue balance

async function b6() {
  const total = QUICK ? 2000 : 20_000;
  const raw = [];
  for (let r = 0; r < RUNS; r++) {
    const nodes = await cluster3();
    try {
      const counts = [0, 0, 0, 0];
      const members = [];
      for (let i = 0; i < 4; i++) {
        const c = await BenchClient.connect(nodes[1 + (i % 2)].host, nodes[1 + (i % 2)].port);
        c.sub("work", () => counts[i]++, "pool");
        members.push(c);
      }
      const pub = await BenchClient.connect(nodes[0].host, nodes[0].port);
      await ready(pub, members, "b6");
      await blast(pub, "work", total);
      await waitUntil(() => counts.reduce((a, b) => a + b, 0) >= total, 30_000, "queue deliveries").catch(() => {});
      await sleep(300);
      // variant: one more member on the PUBLISHER's broker -> local preference
      let localCount = 0;
      const local = await BenchClient.connect(nodes[0].host, nodes[0].port);
      local.sub("work", () => localCount++, "pool");
      await local.flush();
      const before = counts.reduce((a, b) => a + b, 0);
      await blast(pub, "work", 1000);
      await waitUntil(() => localCount + counts.reduce((a, b) => a + b, 0) - before >= 1000, 10_000, "local").catch(() => {});
      raw.push({ run: r, total, counts, sum: before, localVariant: { local: localCount, remote: counts.reduce((a, b) => a + b, 0) - before } });
      for (const c of [...members, pub, local]) c.close();
    } finally {
      await stopAll(nodes);
    }
  }
  const share = (x, i) => round((x.counts[i] / x.total) * 100, 1);
  return {
    title: "B6 Queue group across the cluster: 4 members on brokers B and C, publisher on broker A",
    note: `${RUNS} run(s) of ${total} messages. Each message must reach exactly ONE member in the whole cluster. The origin broker picks a peer at random, the peer picks a member at random, so 25% each is the expectation. Last column: a fifth member then joins on the publisher's own broker and 1000 more messages are sent; local preference means all of them should stay local.`,
    columns: ["run", "delivered / sent", "member 1 (B) %", "member 2 (C) %", "member 3 (B) %", "member 4 (C) %", "with a local member: local / remote"],
    rows: raw.map((x) => [x.run + 1, `${x.sum} / ${x.total}`, share(x, 0), share(x, 1), share(x, 2), share(x, 3), `${x.localVariant.local} / ${x.localVariant.remote}`]),
    raw,
  };
}

// ------------------------------------------------------------------------------------------------ B7: soak

async function b7() {
  const seconds = Number(process.env.SOAK_SECONDS ?? (QUICK ? 15 : 600));
  const nodes = await cluster3();
  const subjects = Array.from({ length: 50 }, (_, i) => `soak.s${i}`);
  const rand = (n) => Math.floor(Math.random() * n);
  let stop = false;
  const tally = { connects: 0, cleanCloses: 0, abruptCloses: 0, subscriptions: 0, delivered: 0, errors: 0 };
  const churner = async () => {
    while (!stop) {
      const node = nodes[rand(nodes.length)];
      let c;
      try {
        c = await BenchClient.connect(node.host, node.port);
      } catch {
        tally.errors++;
        await sleep(100);
        continue;
      }
      tally.connects++;
      const k = 1 + rand(5);
      for (let i = 0; i < k; i++) {
        c.sub(subjects[rand(subjects.length)], () => tally.delivered++, Math.random() < 0.3 ? "q" : undefined);
        tally.subscriptions++;
      }
      await sleep(200 + rand(2800));
      if (Math.random() < 0.5) {
        tally.cleanCloses++;
        for (const sid of [...c.handlers.keys()]) c.unsub(sid);
        await c.flush().catch(() => {});
        c.close();
      } else {
        tally.abruptCloses++;
        c.socket.destroy(); // no UNSUB, no goodbye
      }
    }
  };
  const pub = await BenchClient.connect(nodes[0].host, nodes[0].port);
  const ticker = setInterval(() => {
    for (let i = 0; i < 5; i++) pub.pub(subjects[rand(subjects.length)], PAYLOAD);
    pub.flushOut();
  }, 10);
  const workers = Array.from({ length: 20 }, () => churner());
  await sleep(seconds * 1000);
  stop = true;
  await Promise.all(workers);
  clearInterval(ticker);
  pub.close();
  await sleep(3000); // let the last disconnects and RS- messages settle
  const local = nodes.filter((n) => n.local);
  const finals = local.map((n) => n.stats().at(-1));
  const series = local.map((n) => n.stats().map((s) => ({ t: s.t, rssKiB: s.rssKiB, connections: s.connections, subscriptions: s.subscriptions, remoteInterest: s.remoteInterest })));
  await stopAll(nodes);
  const rssFirst = series.map((s) => s.find((x) => x.connections > 0)?.rssKiB ?? s[0]?.rssKiB);
  return {
    title: `B7 Soak: ${seconds} s of 20 clients connecting, subscribing and disconnecting at random (half abruptly)`,
    note: `A publisher sends 500 msg/s to 50 subjects meanwhile. After the churn stops, every counter must return to zero: connections, subscriptions, and the interest each broker holds from its peers. Totals: ${tally.connects} connections, ${tally.subscriptions} subscriptions, ${tally.abruptCloses} abrupt disconnects, ${tally.delivered} deliveries.${remoteNodes().length ? " Only the LOCAL broker's counters are readable here; the remote brokers' stats are in their own logs." : ""}`,
    columns: ["broker", "connections after", "subscriptions after", "remote interest after", "RSS early MiB", "RSS peak MiB", "RSS at end MiB"],
    rows: finals.map((f, i) => [
      String.fromCharCode(65 + i), f?.connections, f?.subscriptions, f?.remoteInterest,
      round((rssFirst[i] ?? 0) / 1024, 0), round(Math.max(...series[i].map((x) => x.rssKiB)) / 1024, 0), round((f?.rssKiB ?? 0) / 1024, 0),
    ]),
    raw: { seconds, tally, finals, series },
  };
}

export const scenarios = { b1, b2, b3, b4, b5, b6, b7 };
export { median };
