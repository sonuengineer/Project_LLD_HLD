// The experiments. Each returns { title, note, columns, rows, raw } or { skipped: "why" }.
// Numbers in `rows` are computed from `raw`; nothing is typed by hand.
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import {
  QUICK, freePort, load, median, pct, round, rssKiB, sleep, spread, startProxy, startUpstream,
} from "./lib.mjs";

const SECS = QUICK ? 3 : 15; // seconds per load run
const RUNS = QUICK ? 1 : 3; // repetitions per configuration

const isLinux = process.platform === "linux";
const range = (xs, d = 0) => (xs.length ? `${round(Math.min(...xs), d)} - ${round(Math.max(...xs), d)}` : "-");

/** Small deterministic random numbers, so a run can be repeated exactly. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const trim = (r) => ({
  rps: r.requests.average, total: r.requests.total, p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99,
  max: r.latency.max, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts, resets: r.resets,
});

// ---------------------------------------------------------------------------------------------- E1
async function e1() {
  const up = await startUpstream({ name: "u" });
  const px = await startProxy({ UPSTREAM: up.url });
  const quiet = await startProxy({ UPSTREAM: up.url, REQUEST_LOG: "false" });
  const urls = { direct: up.url, proxy: px.url, "proxy, request log off": quiet.url };
  const raw = [];
  try {
    await load({ url: px.url, connections: 8, duration: 2 }); // warm-up, discarded
    await load({ url: quiet.url, connections: 8, duration: 2 });
    for (let run = 1; run <= RUNS; run++) {
      for (const [target, url] of Object.entries(urls)) {
        const r = await load({ url, connections: 32, duration: SECS });
        raw.push({ run, target, ...trim(r) });
      }
    }
  } finally {
    await px.stop();
    await quiet.stop();
    await up.stop();
  }
  const rows = Object.keys(urls).map((target) => {
    const xs = raw.filter((r) => r.target === target);
    return [
      target, round(median(xs.map((x) => x.rps)), 0), range(xs.map((x) => x.rps)), round(median(xs.map((x) => x.p50)), 1),
      round(median(xs.map((x) => x.p97_5)), 1), round(median(xs.map((x) => x.p99)), 1), xs.reduce((s, x) => s + x.non2xx + x.errors, 0),
    ];
  });
  return {
    title: "E1 - what does the proxy cost? (32 connections, tiny responses)",
    note: `Same machine runs the load generator, the proxy and the upstream, so they compete for CPU. Compare the two rows, do not read them as capacity. ${RUNS} run(s) of ${SECS}s each, rotating through the three targets.`,
    columns: ["target", "req/s (median)", "req/s (min-max)", "p50 ms", "p97.5 ms", "p99 ms", "errors+non2xx"],
    rows, raw,
  };
}

// ---------------------------------------------------------------------------------------------- E2
async function e2() {
  const fast = await startUpstream({ name: "fast" });
  const slow = await startUpstream({ name: "slow", delayMs: 40 });
  const slowHost = `127.0.0.1:${slow.port}`;
  const raw = [];
  try {
    for (const strategy of ["round-robin", "least-connections"]) {
      for (let run = 1; run <= RUNS; run++) {
        const px = await startProxy({ UPSTREAM: `${fast.url},${slow.url}`, STRATEGY: strategy });
        try {
          const r = await load({ url: px.url, connections: 32, duration: SECS });
          await sleep(100);
          const reqs = px.requests();
          raw.push({ strategy, run, ...trim(r), slowShare: pct(reqs.filter((q) => q.upstream === slowHost).length, reqs.length) });
        } finally {
          await px.stop();
        }
      }
    }
  } finally {
    await fast.stop();
    await slow.stop();
  }
  const rows = ["round-robin", "least-connections"].map((s) => {
    const xs = raw.filter((r) => r.strategy === s);
    return [
      s, round(median(xs.map((x) => x.rps)), 0), round(median(xs.map((x) => x.p50)), 1), round(median(xs.map((x) => x.p97_5)), 1),
      round(median(xs.map((x) => x.p99)), 1), `${round(median(xs.map((x) => x.slowShare)), 1)}%`,
    ];
  });
  return {
    title: "E2 - round-robin vs least-connections with one slow upstream (40 ms extra)",
    note: `Two upstreams: one answers at once, one waits 40 ms. 32 connections. ${RUNS} run(s) of ${SECS}s per strategy. "slow share" is the fraction of requests the slow one received (from the proxy log).`,
    columns: ["strategy", "req/s", "p50 ms", "p97.5 ms", "p99 ms", "slow share"],
    rows, raw,
  };
}

// ---------------------------------------------------------------------------------------------- E3
async function e3() {
  const configs = [
    { name: "retries 0, passive only", env: { RETRIES: "0" } },
    { name: "retries 1, passive only", env: { RETRIES: "1" } },
    { name: "retries 0, active checks every 1s", env: { RETRIES: "0", HEALTH_PATH: "/health", HEALTH_INTERVAL_MS: "1000" } },
    { name: "retries 1, active checks every 1s", env: { RETRIES: "1", HEALTH_PATH: "/health", HEALTH_INTERVAL_MS: "1000" } },
  ];
  const total = QUICK ? 6 : 14;
  const killAt = QUICK ? 2 : 5;
  const raw = [];
  for (const cfg of configs) {
    for (let run = 1; run <= RUNS; run++) {
      const a = await startUpstream({ name: "A" });
      const b = await startUpstream({ name: "B" });
      const px = await startProxy({ UPSTREAM: `${a.url},${b.url}`, STRATEGY: "round-robin", ...cfg.env });
      try {
        const loading = load({ url: px.url, connections: 32, duration: total });
        await sleep(killAt * 1000);
        const killT = Date.now();
        b.proc.kill("SIGKILL");
        const r = await loading;
        const afterKill = px.requests().filter((q) => q.t >= killT);
        const bad = afterKill.filter((q) => q.status >= 500 || q.error === "UPSTREAM_ABORTED");
        const down = px.events().find((e) => e.msg === "health" && e.healthy === false && e.t >= killT);
        raw.push({
          config: cfg.name, run, ...trim(r), requestsAfterKill: afterKill.length, badAfterKill: bad.length,
          retriedAfterKill: afterKill.filter((q) => q.attempts > 1).length,
          firstBadMs: bad.length ? bad[0].t - killT : null, lastBadMs: bad.length ? bad.at(-1).t - killT : null,
          detectedMs: down ? down.t - killT : null,
        });
      } finally {
        await px.stop();
        await a.stop();
        await b.stop();
      }
    }
  }
  const rows = configs.map((cfg) => {
    const xs = raw.filter((r) => r.config === cfg.name);
    const bad = xs.map((x) => x.badAfterKill);
    return [
      cfg.name, `${round(median(bad), 0)} (${range(bad)})`, `${round(median(xs.map((x) => pct(x.badAfterKill, x.requestsAfterKill))), 2)}%`,
      round(median(xs.map((x) => x.retriedAfterKill)), 0), round(median(xs.map((x) => x.lastBadMs).filter((v) => v !== null)), 0) ?? "-",
      round(median(xs.map((x) => x.detectedMs).filter((v) => v !== null)), 0) ?? "-",
    ];
  });
  return {
    title: "E3 - an upstream is killed under load (SIGKILL, no warning)",
    note: `2 upstreams, round-robin, 32 connections, ${total}s per run, upstream B killed at ${killAt}s. "bad" = 5xx or a body cut short, seen by the proxy after the kill. "last bad ms" = how long after the kill the last bad request finished. "down event ms" = kill until the health event (only where one fired). ${RUNS} run(s) per row.`,
    columns: ["configuration", "bad requests (median, min-max)", "bad share", "requests saved by retry", "last bad ms", "down event ms"],
    rows, raw,
  };
}

// ---------------------------------------------------------------------------------------------- E4
async function e4() {
  const N = QUICK ? 40 : 300;
  const raw = [];
  const kinds = [["node server (sends a Keep-Alive hint)", false], ["raw server (no hint)", true]];
  for (const [kind, isRaw] of kinds) for (const retries of [0, 1]) {
    const up = await startUpstream({ name: "u", keepAliveMs: 200, raw: isRaw });
    const px = await startProxy({ UPSTREAM: up.url, RETRIES: String(retries) });
    const rng = mulberry32(12345);
    const statuses = {};
    try {
      for (let i = 0; i < N; i++) {
        await sleep(150 + rng() * 110); // gaps straddle the upstream's 200 ms keep-alive timeout
        let key;
        try {
          const res = await fetch(`${px.url}/`);
          await res.text();
          key = String(res.status);
        } catch {
          key = "client-error";
        }
        statuses[key] = (statuses[key] ?? 0) + 1;
      }
      await sleep(100);
      const reqs = px.requests();
      const errors = {};
      for (const q of reqs) if (q.error) errors[q.error] = (errors[q.error] ?? 0) + 1;
      raw.push({ kind, retries, N, statuses, errors, retried: reqs.filter((q) => q.attempts > 1).length });
    } finally {
      await px.stop();
      await up.stop();
    }
  }
  const rows = raw.map((r) => [r.kind, r.retries, r.N, JSON.stringify(r.statuses), JSON.stringify(r.errors), r.retried]);
  return {
    title: "E4 - stale keep-alive connections: do resets happen, and do retries hide them?",
    note: "Two kinds of upstream, both closing idle connections after 200 ms: a Node server, and a raw one that sends no Keep-Alive hint. sequential GETs with random gaps of 150-260 ms, so some requests arrive just as the upstream closes the idle connection. Seeded random numbers: the gaps are the same in both rows.",
    columns: ["upstream", "retries", "requests", "client saw (status: count)", "upstream errors seen by proxy", "requests that were retried"],
    rows, raw,
  };
}

// ---------------------------------------------------------------------------------------------- E5
async function e5() {
  if (!isLinux) return { skipped: "needs Linux and sudo iptables (a real black hole on loopback)" };
  const live = await startUpstream({ name: "live" });
  const dead = await startUpstream({ name: "dead" }); // keeps running; the firewall makes it unreachable
  const rule = ["OUTPUT", "-p", "tcp", "-d", "127.0.0.1", "--dport", String(dead.port), "-j", "DROP"];
  const ipt = (...a) => execFileSync("sudo", ["-n", "iptables", ...a], { stdio: "pipe" });
  // Safety net: even if this script is killed, the rule is removed after 120 s.
  const watchdog = spawn("sh", ["-c", `sleep 120; sudo -n iptables -D ${rule.join(" ")} 2>/dev/null`], { detached: true, stdio: "ignore" });
  watchdog.unref();
  const raw = [];
  try {
    ipt("-I", ...rule);
    for (const connectMs of [1000, 3000]) {
      const px = await startProxy({ UPSTREAM: `${dead.url},${live.url}`, STRATEGY: "round-robin", RETRIES: "1", CONNECT_TIMEOUT_MS: String(connectMs) });
      try {
        const calls = [];
        for (let i = 1; i <= 8; i++) {
          const t0 = Date.now();
          const res = await fetch(`${px.url}/`);
          await res.text();
          calls.push({ n: i, method: "GET", status: res.status, ms: Date.now() - t0 });
        }
        await sleep(100);
        px.requests().forEach((q, i) => Object.assign(calls[i], { attempts: q.attempts, error: q.error ?? "", upstream: q.upstream === `127.0.0.1:${dead.port}` ? "dead" : "live" }));
        raw.push({ connectMs, calls, ejected: px.events().filter((e) => e.msg === "health").map((e) => e.reason) });
      } finally {
        await px.stop();
      }
    }
    // A POST aimed at the black hole: must not be retried.
    const px = await startProxy({ UPSTREAM: `${dead.url},${live.url}`, STRATEGY: "round-robin", RETRIES: "1", CONNECT_TIMEOUT_MS: "1000" });
    try {
      const t0 = Date.now();
      const res = await fetch(`${px.url}/`, { method: "POST", body: "x" });
      await res.text();
      await sleep(100);
      const q = px.requests()[0];
      raw.push({ connectMs: 1000, calls: [{ n: 1, method: "POST", status: res.status, ms: Date.now() - t0, attempts: q.attempts, error: q.error ?? "", upstream: "dead" }], ejected: [] });
    } finally {
      await px.stop();
    }
  } finally {
    try { ipt("-D", ...rule); } catch { /* already removed */ }
    try { process.kill(-watchdog.pid); } catch { /* already finished */ }
    await live.stop();
    await dead.stop();
  }
  const rows = raw.flatMap((r) => r.calls.map((c) => [r.connectMs, `${c.method} #${c.n}`, c.upstream, c.status, c.ms, c.attempts, c.error]));
  return {
    title: "E5 - connect timeout against a REAL black hole (packets silently dropped)",
    note: "One upstream is unreachable because the firewall drops its SYN packets (loopback, rule removed afterwards). Upstream order [dead, live], round-robin, retries 1, default ejection (3 failures).",
    columns: ["connect timeout ms", "request", "first target", "status", "ms", "attempts", "last error"],
    rows, raw,
  };
}

// ---------------------------------------------------------------------------------------------- E6
async function e6() {
  const closed = await freePort(); // nothing listens here
  const px = await startProxy({ UPSTREAM: `http://127.0.0.1:${closed}`, RETRIES: "0" });
  try {
    const res = await fetch(`${px.url}/`);
    await res.text();
    await sleep(100);
    const q = px.requests()[0];
    const raw = [{ platform: `${process.platform}`, status: res.status, error: q.error }];
    return {
      title: "E6 - which error does a closed port give? (same host, loopback)",
      note: "Closed port on the SAME machine. A closed port on ANOTHER machine behind a REJECT firewall rule was NOT measured (needs the two-host mode).",
      columns: ["platform", "status to client", "error the proxy recorded"],
      rows: [[raw[0].platform, raw[0].status, raw[0].error]], raw,
    };
  } finally {
    await px.stop();
  }
}

// ---------------------------------------------------------------------------------------------- E7
async function e7() {
  if (!isLinux) return { skipped: "reads /proc for resident memory (Linux only)" };
  const MB = QUICK ? 64 : 1024;
  const up = await startUpstream({ name: "big" });
  const px = await startProxy({ UPSTREAM: up.url });
  const samples = [];
  const timer = setInterval(async () => {
    samples.push({ t: Date.now(), proxy: await rssKiB(px.proc.pid), upstream: await rssKiB(up.proc.pid) });
  }, 200);
  try {
    await sleep(1500);
    const idleEnd = Date.now();
    const t0 = Date.now();
    const bytes = await new Promise((resolve, reject) => {
      http.get(`${px.url}/big?mb=${MB}`, (res) => {
        let n = 0;
        res.on("data", (c) => (n += c.length)); // consumed and thrown away
        res.on("end", () => resolve(n));
        res.on("error", reject);
      }).on("error", reject);
    });
    const ms = Date.now() - t0;
    await sleep(500);
    clearInterval(timer);
    const idle = samples.filter((s) => s.t <= idleEnd);
    const during = samples.filter((s) => s.t > idleEnd);
    const raw = { MB, bytes, ms, samples };
    return {
      title: `E7 - memory while streaming ${MB} MiB through the proxy`,
      note: "Resident memory (RSS) of the proxy and the upstream, sampled every 200 ms, before and during one large transfer. Streaming should keep the proxy near its idle size; buffering would grow it by about the file size.",
      columns: ["MiB sent", "bytes received", "complete?", "seconds", "proxy RSS idle MiB", "proxy RSS max MiB", "proxy growth MiB", "upstream RSS max MiB"],
      rows: [[
        MB, bytes, bytes === MB * 1024 * 1024 ? "yes" : "NO", round(ms / 1000, 1),
        round(median(idle.map((s) => s.proxy)) / 1024, 1), round(Math.max(...during.map((s) => s.proxy)) / 1024, 1),
        round((Math.max(...during.map((s) => s.proxy)) - median(idle.map((s) => s.proxy))) / 1024, 1),
        round(Math.max(...during.map((s) => s.upstream)) / 1024, 1),
      ]], raw,
    };
  } finally {
    clearInterval(timer);
    await px.stop();
    await up.stop();
  }
}

// ---------------------------------------------------------------------------------------------- E8
async function e8() {
  const secs = Number(process.env.SOAK_SECONDS ?? (QUICK ? 15 : 1800));
  const a = await startUpstream({ name: "A" });
  const b = await startUpstream({ name: "B" });
  const flaky = await startUpstream({ name: "flaky", resetPercent: 5 });
  const px = await startProxy({
    UPSTREAM: `${a.url},${b.url},${flaky.url}`, STRATEGY: "least-connections", RETRIES: "1",
    HEALTH_PATH: "/health", HEALTH_INTERVAL_MS: "2000", STATS_INTERVAL_MS: "5000",
  });
  const rng = mulberry32(777);
  const tally = {};
  const bump = (k) => (tally[k] = (tally[k] ?? 0) + 1);
  const rss = [];
  const sampler = isLinux ? setInterval(async () => rss.push(await rssKiB(px.proc.pid)), 10_000) : null;
  const deadline = Date.now() + secs * 1000;
  async function worker() {
    while (Date.now() < deadline) {
      const x = rng();
      try {
        if (x < 0.7) {
          bump(String((await fetch(`${px.url}/`).then(async (r) => (await r.text(), r))).status));
        } else if (x < 0.8) {
          bump(String((await fetch(`${px.url}/work?ms=50`).then(async (r) => (await r.text(), r))).status));
        } else if (x < 0.9) {
          const ctl = new AbortController();
          setTimeout(() => ctl.abort(), 1 + rng() * 30);
          await fetch(`${px.url}/work?ms=200`, { signal: ctl.signal }).then((r) => r.text());
          bump("200-late");
        } else {
          bump("POST " + (await fetch(`${px.url}/`, { method: "POST", body: "small" }).then(async (r) => (await r.text(), r))).status);
        }
      } catch (err) {
        bump(err?.name === "AbortError" ? "client-aborted" : "client-error");
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: 16 }, worker));
    await sleep(7000); // let in-flight work finish and one more stats line appear
    const reqs = px.requests();
    const stats = px.events().filter((e) => e.msg === "stats");
    const last = stats.at(-1);
    const errors = {};
    for (const q of reqs) if (q.error) errors[q.error] = (errors[q.error] ?? 0) + 1;
    const healthEvents = px.events().filter((e) => e.msg === "health").length;
    if (sampler) clearInterval(sampler);
    const raw = { secs, tally, errors, requestsLogged: reqs.length, retried: reqs.filter((q) => q.attempts > 1).length, healthEvents, lastStats: last, rssKiB: rss };
    return {
      title: `E8 - ${secs}s soak with random client aborts, POSTs and a flaky upstream (5% connection resets)`,
      note: "16 concurrent clients; 70% GET, 10% slow GET, 10% GET aborted by the client after 1-30 ms, 10% POST. Least-connections, retries 1, active checks every 2 s. After the clients stop, every upstream's active count must be 0.",
      columns: ["requests logged", "client saw", "proxy errors seen", "retried", "health events", "final active counts", "proxy RSS MiB first/last/max"],
      rows: [[
        reqs.length, JSON.stringify(tally), JSON.stringify(errors), raw.retried, healthEvents,
        last ? JSON.stringify(last.targets.map((t) => t.active)) : "no stats line",
        rss.length ? `${round(rss[0] / 1024, 1)} / ${round(rss.at(-1) / 1024, 1)} / ${round(Math.max(...rss) / 1024, 1)}` : "n/a",
      ]], raw,
    };
  } finally {
    if (sampler) clearInterval(sampler);
    await px.stop();
    await a.stop();
    await b.stop();
    await flaky.stop();
  }
}

// ---------------------------------------------------------------------------------------------- E9
async function e9() {
  if (process.platform === "win32") return { skipped: "Windows cannot deliver a catchable SIGTERM to Node" };
  const up = await startUpstream({ name: "w" });
  const px = await startProxy({ UPSTREAM: up.url });
  const t0 = Date.now();
  const inflight = Array.from({ length: 10 }, () =>
    fetch(`${px.url}/work?ms=2000`).then(async (r) => (await r.text(), r.status), () => "client-error"));
  await sleep(500);
  const sigT = Date.now();
  px.proc.kill("SIGTERM");
  const results = await Promise.all(inflight);
  const exit = await px.exited;
  let refused = false;
  try { await fetch(`${px.url}/`); } catch { refused = true; }
  await up.stop();
  const raw = { results, exit, exitAfterSigtermMs: exit.t - sigT, refusedAfter: refused, totalMs: Date.now() - t0 };
  return {
    title: "E9 - graceful shutdown with 10 requests in flight (each takes 2 s, SIGTERM after 0.5 s)",
    note: "SIGTERM is sent to the real CLI process. The in-flight requests must still complete, the process must exit with code 0, and it must stop accepting new connections.",
    columns: ["in-flight completed 200", "failed", "exit code", "exit after SIGTERM ms", "new connection refused afterwards"],
    rows: [[results.filter((s) => s === 200).length, results.filter((s) => s !== 200).length, exit.code, exit.t - sigT, refused ? "yes" : "NO"]], raw,
  };
}

export const scenarios = { e1, e2, e3, e4, e5, e6, e7, e8, e9 };
