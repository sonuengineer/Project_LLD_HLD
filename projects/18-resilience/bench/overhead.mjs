// Per-call overhead of the policies on a no-op async operation, ours vs cockatiel 3.2.1 (dev dependency only).
// Measures the wrapper cost, NOT network behaviour: the operation is `async () => 1`, so this is the worst case for
// relative overhead. Sequential awaits (one call at a time). Run: npm run bench
//
// Writes bench/reference-results/<date>-<platform>.json with every round, so the README numbers can be checked.
import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import * as c from "cockatiel";
import { Bulkhead, CircuitBreaker, RetryPolicy, TimeoutPolicy, wrap } from "../dist/index.js";

const N = 100_000;
const ROUNDS = 5;
const WARMUP = 20_000;
const op = async () => 1;

const ours = {
  timeout: new TimeoutPolicy({ ms: 10_000 }),
  retry: new RetryPolicy({ maxAttempts: 3 }),
  breaker: new CircuitBreaker({ openMs: 10_000 }),
  bulkhead: new Bulkhead({ maxConcurrent: 10 }),
};
ours.all = wrap(new RetryPolicy({ maxAttempts: 3 }), new CircuitBreaker({ openMs: 10_000 }), new Bulkhead({ maxConcurrent: 10 }), new TimeoutPolicy({ ms: 10_000 }));

const ck = {
  timeout: c.timeout(10_000, c.TimeoutStrategy.Cooperative),
  retry: c.retry(c.handleAll, { maxAttempts: 2, backoff: new c.ExponentialBackoff() }), // cockatiel counts RETRIES: 2 = 3 attempts
  breaker: c.circuitBreaker(c.handleAll, { halfOpenAfter: 10_000, breaker: new c.ConsecutiveBreaker(5) }),
  bulkhead: c.bulkhead(10, 0),
};
ck.all = c.wrap(
  c.retry(c.handleAll, { maxAttempts: 2, backoff: new c.ExponentialBackoff() }),
  c.circuitBreaker(c.handleAll, { halfOpenAfter: 10_000, breaker: new c.ConsecutiveBreaker(5) }),
  c.bulkhead(10, 0),
  c.timeout(10_000, c.TimeoutStrategy.Cooperative),
);

const cases = [
  ["bare call", () => op()],
  ...["timeout", "retry", "breaker", "bulkhead", "all"].flatMap((k) => [
    [`ours: ${k}`, () => ours[k].execute(op)],
    [`cockatiel: ${k}`, () => ck[k].execute(op)],
  ]),
];

async function measure(fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await fn();
    const ms = performance.now() - t0;
    rounds.push({ ms: +ms.toFixed(2), nsPerCall: +((ms * 1e6) / N).toFixed(1) });
  }
  const sorted = [...rounds].sort((a, b) => a.nsPerCall - b.nsPerCall);
  return { median: sorted[Math.floor(ROUNDS / 2)].nsPerCall, rounds };
}

const results = [];
for (const [name, fn] of cases) {
  const r = await measure(fn);
  results.push({ name, medianNsPerCall: r.median, rounds: r.rounds });
  console.log(`${name.padEnd(22)} ${String(r.median).padStart(8)} ns/call`);
}

const date = new Date().toISOString().slice(0, 10);
const out = {
  what: "per-call overhead on `async () => 1`, sequential, median of rounds",
  date,
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  callsPerRound: N,
  rounds: ROUNDS,
  warmup: WARMUP,
  cockatiel: "3.2.1",
  results,
};
mkdirSync(new URL("./reference-results/", import.meta.url), { recursive: true });
const file = new URL(`./reference-results/${date}-${platform()}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwritten ${file.pathname}`);
