// Shared helpers for the experiments. Everything here is plumbing: starting processes, timing, saving raw results.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const DIST = path.join(ROOT, "dist", "index.js");
export const QUICK = process.env.BENCH_QUICK === "1";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

export function median(values) {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
export const spread = (values) => (values.length ? { min: Math.min(...values), max: Math.max(...values) } : null);
export const round = (n, d = 1) => (n === null || n === undefined ? null : Number(n.toFixed(d)));

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
  };
}

export function makeResultsDir(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(HERE, "results", `${stamp}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const save = (dir, name, data) => writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));

/** Starts a child process and collects its stdout lines with the time each one arrived. */
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
  const ready_ = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} not ready in 10 s. stderr: ${stderr}`)), 10_000);
    const check = setInterval(() => {
      if (lines.some((l) => ready.test(l.text))) {
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
    ready: ready_,
    json,
    requests: () => json().filter((e) => e.method !== undefined),
    events: () => json().filter((e) => e.msg === "health" || e.msg === "stats"),
    stop: async (signal = "SIGTERM") => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      await Promise.race([exited, sleep(3000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    },
  };
}

export async function startUpstream({ name = "upstream", delayMs = 0, keepAliveMs, resetPercent = 0, port, raw = false } = {}) {
  port ??= await freePort();
  const env = { PORT: String(port), NAME: name, DELAY_MS: String(delayMs), RESET_PERCENT: String(resetPercent) };
  if (raw) env.RAW = "1";
  if (keepAliveMs) env.KEEPALIVE_MS = String(keepAliveMs);
  const up = start(process.execPath, [path.join(HERE, "upstream.mjs")], { env, ready: /"msg":"listening"/, label: `upstream ${name}` });
  await up.ready;
  return { ...up, port, name, url: `http://127.0.0.1:${port}` };
}

export async function startProxy(env) {
  if (!existsSync(DIST)) throw new Error("dist/ is missing: run `npm run build` in the project folder first");
  const port = await freePort();
  const px = start(process.execPath, [DIST], {
    env: { PORT: String(port), HOST: "127.0.0.1", ...env },
    ready: /"msg":"listening"/,
    label: "proxy",
  });
  await px.ready;
  return { ...px, port, url: `http://127.0.0.1:${port}` };
}

/** One autocannon run. Returns the raw result object. */
export function load({ url, connections = 32, duration = 15, ...rest }) {
  return autocannon({ url, connections, duration, ...rest });
}

export const pct = (part, total) => (total ? round((part / total) * 100, 1) : null);

/** Aggregate CPU time counters from /proc/stat (Linux only), or null. Used to report steal and iowait over a run. */
export function cpuTimes() {
  try {
    const first = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = first;
    return { user, nice, system, idle, iowait, irq, softirq, steal: steal ?? 0, total: first.slice(0, 8).reduce((a, b) => a + b, 0) };
  } catch {
    return null;
  }
}

/** Share of CPU time spent in each state between two cpuTimes() readings, in percent. */
export function cpuShare(a, b) {
  if (!a || !b) return null;
  const total = b.total - a.total;
  const share = (k) => round(((b[k] - a[k]) / total) * 100, 2);
  return { steal: share("steal"), iowait: share("iowait"), idle: share("idle"), busy: round(100 - share("idle") - share("iowait") - share("steal"), 2) };
}

/** Resident memory of a process in KiB (Linux only). */
export async function rssKiB(pid) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(`/proc/${pid}/status`, "utf8");
  const m = /VmRSS:\s+(\d+) kB/.exec(text);
  return m ? Number(m[1]) : null;
}
