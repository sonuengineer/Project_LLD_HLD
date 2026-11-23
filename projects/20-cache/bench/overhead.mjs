// Per-operation cost of LruCache on this machine, next to a plain Map as the floor. Single thread, no concurrency.
// Measures the cache's own bookkeeping, NOT the value of caching (that depends on what a miss costs you: a DB query
// is ~1 ms, i.e. ~10 000x any number here). Run: npm run bench
//
// Writes bench/reference-results/<date>-<platform>.json with every round, so the README numbers can be checked.
import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { LruCache } from "../dist/index.js";

const N = 1_000_000; // operations per round
const ROUNDS = 7;
const WARMUP = 200_000;
const KEYS = 10_000; // every cache below holds 10 000 entries
let sink = 0; // results go here so the engine cannot drop the work

function filledCache(options = {}) {
  const c = new LruCache({ maxEntries: KEYS, ...options });
  for (let i = 0; i < KEYS; i++) c.set(i, i);
  return c;
}
const map = new Map();
for (let i = 0; i < KEYS; i++) map.set(i, i);

const hitCache = filledCache();
const missCache = filledCache();
const setCache = filledCache();
const evictCache = filledCache();
const ttlCache = filledCache({ ttlMs: 3_600_000 });
let next = KEYS; // evicting sets use ever-new keys

const cases = [
  ["Map.get (floor)", (i) => { sink += map.get(i % KEYS); }],
  ["get hit", (i) => { sink += hitCache.get(i % KEYS); }],
  ["get hit, ttlMs set", (i) => { sink += ttlCache.get(i % KEYS); }],
  ["get miss", (i) => { sink += missCache.get(KEYS + (i % KEYS)) === undefined ? 1 : 0; }],
  ["set existing key", (i) => { setCache.set(i % KEYS, i); }],
  ["set new key (evicts LRU)", () => { evictCache.set(next++, 1); }],
];

function measure(fn) {
  for (let i = 0; i < WARMUP; i++) fn(i);
  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) fn(i);
    const ms = performance.now() - t0;
    rounds.push({ ms: +ms.toFixed(2), nsPerOp: +((ms * 1e6) / N).toFixed(1) });
  }
  const sorted = [...rounds].sort((a, b) => a.nsPerOp - b.nsPerOp);
  return { median: sorted[Math.floor(ROUNDS / 2)].nsPerOp, rounds };
}

// getOrLoad hit is async (one await per call), measured with sequential awaits.
async function measureAsync(fn) {
  for (let i = 0; i < WARMUP; i++) await fn(i);
  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await fn(i);
    const ms = performance.now() - t0;
    rounds.push({ ms: +ms.toFixed(2), nsPerOp: +((ms * 1e6) / N).toFixed(1) });
  }
  const sorted = [...rounds].sort((a, b) => a.nsPerOp - b.nsPerOp);
  return { median: sorted[Math.floor(ROUNDS / 2)].nsPerOp, rounds };
}

const results = [];
for (const [name, fn] of cases) {
  const r = measure(fn);
  results.push({ name, medianNsPerOp: r.median, rounds: r.rounds });
  console.log(`${name.padEnd(28)} ${String(r.median).padStart(8)} ns/op`);
}
const loadCache = filledCache();
const loader = async () => 0;
const r = await measureAsync(async (i) => { sink += await loadCache.getOrLoad(i % KEYS, loader); });
results.push({ name: "getOrLoad hit (awaited)", medianNsPerOp: r.median, rounds: r.rounds });
console.log(`${"getOrLoad hit (awaited)".padEnd(28)} ${String(r.median).padStart(8)} ns/op`);

const date = new Date().toISOString().slice(0, 10);
const out = {
  what: "ns per operation on a cache of 10 000 entries, single thread, median of rounds",
  date,
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  opsPerRound: N,
  rounds: ROUNDS,
  warmup: WARMUP,
  sink,
  results,
};
mkdirSync(new URL("./reference-results/", import.meta.url), { recursive: true });
const file = new URL(`./reference-results/${date}-${platform()}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwritten ${file.pathname}`);
