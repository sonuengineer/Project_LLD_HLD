#!/usr/bin/env node
import { Balancer, STRATEGIES } from "./balancer.js";
import type { Strategy } from "./balancer.js";
import { createProxy } from "./proxy.js";
import { gracefulShutdown } from "./shutdown.js";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Reads a whole-number setting from the environment: undefined when unset, a clear error when it is not a number. */
function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a whole number, got "${raw}"`);
  return value;
}

const upstreamRaw = process.env.UPSTREAM;
if (!upstreamRaw) fail("UPSTREAM is required, for example UPSTREAM=http://127.0.0.1:3000 (several: comma separated)");

const strategy = (process.env.STRATEGY ?? "round-robin") as Strategy;
if (!STRATEGIES.includes(strategy)) fail(`STRATEGY must be one of: ${STRATEGIES.join(", ")}`);

const port = intEnv("PORT") ?? 8080;
const host = process.env.HOST ?? "127.0.0.1";
const healthPath = process.env.HEALTH_PATH;

let balancer: Balancer;
try {
  balancer = new Balancer(
    upstreamRaw.split(",").map((u) => new URL(u.trim())),
    strategy,
    {
      ejectAfter: intEnv("EJECT_AFTER"),
      ejectMs: intEnv("EJECT_MS"),
      onHealthChange: (event) => console.log(JSON.stringify({ msg: "health", ...event })),
    },
  );
} catch (err) {
  fail(`invalid UPSTREAM: ${(err as Error).message}`);
}

const server = createProxy({
  balancer,
  trustForwarded: process.env.TRUST_FORWARDED === "true",
  upstreamTimeoutMs: intEnv("UPSTREAM_TIMEOUT_MS"),
  connectTimeoutMs: intEnv("CONNECT_TIMEOUT_MS"),
  retries: intEnv("RETRIES"),
  healthCheck: healthPath ? { path: healthPath, intervalMs: intEnv("HEALTH_INTERVAL_MS") } : undefined,
  // One line per request is handy but costs a write per request. REQUEST_LOG=false turns it off.
  log: process.env.REQUEST_LOG === "false" ? undefined : (entry) => console.log(JSON.stringify(entry)),
});

// Optional: one line per interval with every upstream's active count and health, to see leaks in a long run.
const statsMs = intEnv("STATS_INTERVAL_MS");
if (statsMs) setInterval(() => console.log(JSON.stringify({ msg: "stats", targets: balancer.snapshot() })), statsMs).unref();

server.listen(port, host, () =>
  console.log(JSON.stringify({ msg: "listening", host, port, strategy, upstream: upstreamRaw, activeHealthCheck: healthPath ?? null })),
);

// Graceful shutdown: stop accepting, let in-flight requests finish, keep dropping idle keep-alive sockets.
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return; // a second signal must not start a second shutdown
  shuttingDown = true;
  void gracefulShutdown(server).then((outcome) => process.exit(outcome === "closed" ? 0 : 1));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
