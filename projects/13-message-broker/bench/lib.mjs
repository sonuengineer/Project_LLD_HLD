// Shared plumbing for the experiments: processes, ports, statistics, raw result files, CPU steal.
// Same method as H11's bench: raw JSON per experiment, median of runs with min-max, nothing typed by hand.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const DIST = path.join(ROOT, "dist", "index.js");
export const QUICK = process.env.BENCH_QUICK === "1";
export const RUNS = QUICK ? 1 : Number(process.env.BENCH_RUNS ?? 3);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, host, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

export function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
export const spread = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
};
export const round = (n, d = 1) => (n === null || n === undefined ? null : Number(n.toFixed(d)));
/** "median (min-max)" for a table cell. */
export const cell = (values, d = 0) => {
  const m = median(values);
  const s = spread(values);
  if (m === null) return "-";
  return values.length > 1 ? `${round(m, d)} (${round(s.min, d)}-${round(s.max, d)})` : `${round(m, d)}`;
};

/** Percentile of an already sorted array (nearest-rank). */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function envInfo() {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  };
  return {
    date: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    // On a server the code arrives as a git archive (no .git folder): pass the commit in BENCH_COMMIT.
    commit: process.env.BENCH_COMMIT ?? git("rev-parse", "--short", "HEAD"),
    dirty: process.env.BENCH_COMMIT ? false : git("status", "--porcelain", "--", ".") !== "",
    quick: QUICK,
    runs: RUNS,
    topology: topologyLabel(),
  };
}

export function makeResultsDir(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(HERE, "results", `${stamp}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const save = (dir, name, data) => writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));

/** Starts a child process and collects its stdout lines (with arrival time); parses JSON lines on demand. */
export function start(cmd, args, { env = {}, ready, label }) {
  const proc = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push({ t: Date.now(), text: buf.slice(0, i) });
      buf = buf.slice(i + 1);
    }
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal, t: Date.now() })));
  const readyP = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} not ready in 10 s. stderr: ${stderr}`)), 10_000);
    const check = setInterval(() => {
      // Some programs (nats-server) log to stderr, so look in both.
      if (lines.some((l) => ready.test(l.text)) || ready.test(stderr)) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 20);
    proc.once("exit", () => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error(`${label} exited early. stderr: ${stderr}`));
    });
  });
  const json = () =>
    lines.flatMap((l) => {
      try {
        return [{ t: l.t, ...JSON.parse(l.text) }];
      } catch {
        return [];
      }
    });
  return {
    proc,
    lines,
    exited,
    ready: readyP,
    json,
    stats: () => json().filter((e) => e.event === "stats"),
    stop: async (signal = "SIGTERM") => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      await Promise.race([exited, sleep(3000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await exited;
    },
  };
}

/**
 * Start one OUR broker as a child process (the real built CLI, not an in-process object, so it has its own event loop
 * and its memory can be read from /proc). Returns its client address and cluster address.
 */
export async function startBroker({ host = process.env.BENCH_HOST ?? "127.0.0.1", clusterPort, routes = [], env = {} } = {}) {
  if (!existsSync(DIST)) throw new Error("dist/ is missing: run `npm run build` in the project folder first");
  const port = await freePort(host);
  clusterPort ??= await freePort(host);
  const b = start(process.execPath, [DIST], {
    env: {
      HOST: host,
      PORT: String(port),
      CLUSTER_PORT: String(clusterPort),
      ROUTES: routes.join(","),
      ROUTE_RECONNECT_MS: "100",
      STATS_INTERVAL_MS: "500",
      ALLOW_NON_LOOPBACK: host === "127.0.0.1" ? "" : "1",
      ...env,
    },
    ready: /"event":"listening"/,
    label: "broker",
  });
  await b.ready;
  return { ...b, kind: "ours", local: true, host, port, clusterPort, clusterUrl: `${host}:${clusterPort}` };
}

/** The real nats-server binary, as a reference point (B2). Path from NATS_SERVER_BIN; skipped when unset. */
export async function startNatsServer() {
  const bin = process.env.NATS_SERVER_BIN;
  if (!bin) return null;
  const port = await freePort();
  const b = start(bin, ["-a", "127.0.0.1", "-p", String(port)], { ready: /Server is ready/, label: "nats-server" });
  // Await the ready promise: left un-awaited, its rejection when the process is later stopped crashed the whole first
  // server run (unhandled rejection). The port check stays as a second guard.
  await b.ready;
  await waitForPort(port);
  return { ...b, kind: "nats-server", local: true, host: "127.0.0.1", port };
}

async function waitForPort(port, ms = 10_000) {
  const { connect } = await import("node:net");
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const s = connect(port, "127.0.0.1", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`port ${port} did not open`);
}

/**
 * Remote brokers already running on other servers, from REMOTE_NODES="host:clientPort:clusterPort,...".
 * Empty in single-host mode. The bench cannot kill or restart these; it only connects to them.
 */
export function remoteNodes() {
  return (process.env.REMOTE_NODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [host, port, clusterPort] = s.split(":");
      return { kind: "ours", local: false, host, port: Number(port), clusterPort: Number(clusterPort), clusterUrl: `${host}:${clusterPort}` };
    });
}

export function topologyLabel() {
  const remote = remoteNodes();
  return remote.length === 0
    ? "single host: every broker and every client on ONE machine over loopback"
    : `multi host: one local broker plus ${remote.length} remote broker(s) over the private network`;
}

/**
 * A 3-node cluster. Single-host: three local brokers that all dial each other. Multi-host: one local broker (so the
 * bench can kill it) that dials the remote ones; the remote ones are expected to list the local cluster address in
 * their own ROUTES (or be dialled by it, which is enough to form the mesh edges from here).
 */
export async function cluster3({ localClusterPort, env = {} } = {}) {
  const remote = remoteNodes();
  if (remote.length === 0) {
    const ports = [await freePort(), await freePort(), await freePort()];
    const urls = ports.map((p) => `127.0.0.1:${p}`);
    const nodes = await Promise.all(ports.map((p, i) => startBroker({ clusterPort: p, routes: urls.filter((_, j) => j !== i), env })));
    await waitMesh(nodes, 2);
    return nodes;
  }
  if (remote.length !== 2) throw new Error("REMOTE_NODES must list exactly 2 brokers for the 3-node experiments");
  const local = await startBroker({ clusterPort: localClusterPort, routes: remote.map((r) => r.clusterUrl), env });
  await waitMesh([local], 2);
  return [local, ...remote];
}

/** Waits until each LOCAL node reports the expected number of routes in its stats line. */
export async function waitMesh(nodes, routes, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const ok = nodes.filter((n) => n.local).every((n) => n.stats().at(-1)?.routes === routes);
    if (ok) return;
    if (Date.now() > end) throw new Error(`mesh not formed: ${nodes.map((n) => n.stats().at(-1)?.routes).join(",")}`);
    await sleep(100);
  }
}

export async function stopAll(nodes) {
  await Promise.all(nodes.filter((n) => n?.local && n.stop).map((n) => n.stop()));
}

/** Aggregate CPU time counters from /proc/stat (Linux only), or null. Used to report steal over a run. */
export function cpuTimes() {
  try {
    const first = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = first;
    return { user, nice, system, idle, iowait, irq, softirq, steal: steal ?? 0, total: first.slice(0, 8).reduce((a, b) => a + b, 0) };
  } catch {
    return null;
  }
}

export function cpuShare(a, b) {
  if (!a || !b) return null;
  const total = b.total - a.total;
  const share = (k) => round(((b[k] - a[k]) / total) * 100, 2);
  return { steal: share("steal"), iowait: share("iowait"), idle: share("idle"), busy: round(100 - share("idle") - share("iowait") - share("steal"), 2) };
}

/** Resident memory of a process in KiB, from /proc (Linux only); null elsewhere. */
export function rssKiB(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
