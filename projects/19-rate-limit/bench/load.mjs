// Load test: N app INSTANCES (separate Node processes, like N replicas) behind no load balancer -- the client
// spreads requests over them round-robin -- all limiting against ONE Redis.
//
// For each mode (no limiter / MemoryStore / RedisStore) it measures, on THIS machine:
//   - requests per second and latency p50 / p99 seen by the client, with C concurrent connections
//   - correctness under load: with a shared key and a limit of L per window, how many requests were allowed in total
//     across all instances (Redis: must be exactly L; memory: up to N x L -- each instance counts alone)
//
// Run:  npm run build && node bench/load.mjs
// Needs Redis (REDIS_URL or redis://127.0.0.1:56379). Writes bench/reference-results/<date>-<platform>-load.json;
// the committed results were renamed by hand to -load-run1.json / -load-run2.json (one file per run).
import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";

const INSTANCES = 3;
const CONCURRENCY = 32;
const DURATION_MS = 8000;
const WARMUP_MS = 1500;
const LIMIT = 500; // per window, for the correctness run
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";

if (process.argv[2] === "--instance") {
  // ---- one app instance ----
  const { default: express } = await import("express");
  const { Redis } = await import("ioredis");
  const { MemoryStore, RateLimiter, RedisStore, ioredisClient, slidingWindow, tokenBucket } = await import("../dist/index.js");
  const { rateLimit } = await import("../dist/adapters/express.js");
  const [mode, prefix] = [process.argv[3], process.argv[4]];
  const redis = mode === "redis" || mode === "redis-shared" ? new Redis(REDIS_URL) : undefined;
  const store = redis ? new RedisStore(ioredisClient(redis)) : new MemoryStore();
  const app = express();
  if (mode === "memory" || mode === "redis") {
    // Throughput run: a generous limit per client so (almost) everything is allowed; each request does a real check.
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 1e9, refillPerSec: 1e9 }), store, prefix });
    app.use(rateLimit(limiter, { key: (req) => `c:${req.headers["x-client"]}` }));
  } else if (mode === "memory-shared" || mode === "redis-shared") {
    // Correctness run: ONE shared key, LIMIT per 10 minutes, all instances.
    const limiter = new RateLimiter({ algorithm: slidingWindow({ limit: LIMIT, windowMs: 600_000 }), store, prefix });
    app.use(rateLimit(limiter, { key: () => "shared" }));
  }
  app.get("/", (_req, res) => res.send("ok"));
  const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  process.on("message", async (m) => {
    if (m === "stop") {
      server.close();
      await redis?.quit();
      process.exit(0);
    }
  });
} else {
  // ---- the driver ----
  const { Redis } = await import("ioredis");
  const admin = new Redis(REDIS_URL);
  const prefix = `rlbench:${process.pid}:`;

  async function startInstances(mode) {
    const procs = [];
    for (let i = 0; i < INSTANCES; i++) {
      const p = fork(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ["--instance", mode, `${prefix}${mode}:`]);
      const port = await new Promise((r) => p.once("message", (m) => r(m.port)));
      procs.push({ p, url: `http://127.0.0.1:${port}/` });
    }
    return procs;
  }
  const stopInstances = async (procs) => {
    for (const { p } of procs) p.send("stop");
    await Promise.all(procs.map(({ p }) => new Promise((r) => p.once("exit", r))));
  };

  async function run(urls, ms, record) {
    const lat = [];
    const statuses = {};
    let n = 0;
    const end = performance.now() + ms;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, w) => {
        while (performance.now() < end) {
          const url = urls[n++ % urls.length];
          const t0 = performance.now();
          const r = await fetch(url, { headers: { "x-client": `client-${w}` } });
          await r.arrayBuffer();
          if (record) {
            lat.push(performance.now() - t0);
            statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          }
        }
      }),
    );
    return { lat, statuses };
  }

  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const results = [];
  for (const mode of ["none", "memory", "redis"]) {
    const procs = await startInstances(mode);
    const urls = procs.map((x) => x.url);
    await run(urls, WARMUP_MS, false);
    const { lat, statuses } = await run(urls, DURATION_MS, true);
    await stopInstances(procs);
    lat.sort((a, b) => a - b);
    const r = {
      mode,
      requests: lat.length,
      reqPerSec: Math.round(lat.length / (DURATION_MS / 1000)),
      p50ms: +pct(lat, 50).toFixed(2),
      p99ms: +pct(lat, 99).toFixed(2),
      statuses,
    };
    results.push(r);
    console.log(JSON.stringify(r));
  }

  const correctness = [];
  for (const mode of ["memory-shared", "redis-shared"]) {
    const procs = await startInstances(mode);
    const { statuses } = await run(procs.map((x) => x.url), 3000, true);
    await stopInstances(procs);
    const r = { mode, limitPerWindow: LIMIT, instances: INSTANCES, allowed: statuses[200] ?? 0, denied: statuses[429] ?? 0, other: Object.fromEntries(Object.entries(statuses).filter(([s]) => s !== "200" && s !== "429")) };
    correctness.push(r);
    console.log(JSON.stringify(r));
  }

  const keys = await admin.keys(`${prefix}*`);
  if (keys.length > 0) await admin.del(...keys);
  await admin.quit();

  const date = new Date().toISOString().slice(0, 10);
  const out = {
    what: `${INSTANCES} Express instances (separate processes) on one Redis; client round-robin over them, ${CONCURRENCY} concurrent connections, ${DURATION_MS} ms measured after ${WARMUP_MS} ms warm-up; client and Redis on the same machine`,
    date,
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    redis: REDIS_URL.replace(/\/\/.*@/, "//"),
    throughput: results,
    correctness,
  };
  mkdirSync(new URL("./reference-results/", import.meta.url), { recursive: true });
  const file = new URL(`./reference-results/${date}-${platform()}-load.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`written ${file.pathname}`);
}
