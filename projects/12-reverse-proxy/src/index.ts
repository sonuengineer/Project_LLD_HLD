#!/usr/bin/env node
import { STRATEGIES } from "./balancer.js";
import type { Strategy } from "./balancer.js";
import { createProxy } from "./proxy.js";

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

const server = createProxy({
  upstream: upstreamRaw.split(",").map((u) => new URL(u.trim())),
  strategy,
  trustForwarded: process.env.TRUST_FORWARDED === "true",
  upstreamTimeoutMs: intEnv("UPSTREAM_TIMEOUT_MS"),
  connectTimeoutMs: intEnv("CONNECT_TIMEOUT_MS"),
  retries: intEnv("RETRIES"),
  ejectAfter: intEnv("EJECT_AFTER"),
  ejectMs: intEnv("EJECT_MS"),
  healthCheck: healthPath ? { path: healthPath, intervalMs: intEnv("HEALTH_INTERVAL_MS") } : undefined,
  onHealthChange: (event) => console.log(JSON.stringify({ msg: "health", ...event })),
  log: (entry) => console.log(JSON.stringify(entry)),
});

server.listen(port, host, () =>
  console.log(JSON.stringify({ msg: "listening", host, port, strategy, upstream: upstreamRaw, activeHealthCheck: healthPath ?? null })),
);

// Graceful shutdown: stop accepting, let in-flight requests finish, drop idle keep-alive sockets.
function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
