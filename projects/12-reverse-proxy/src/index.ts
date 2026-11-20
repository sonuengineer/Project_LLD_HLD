#!/usr/bin/env node
import { STRATEGIES } from "./balancer.js";
import type { Strategy } from "./balancer.js";
import { createProxy } from "./proxy.js";

const upstreamRaw = process.env.UPSTREAM;
if (!upstreamRaw) {
  console.error("UPSTREAM is required, for example UPSTREAM=http://127.0.0.1:3000 (several: comma separated)");
  process.exit(2);
}

const strategy = (process.env.STRATEGY ?? "round-robin") as Strategy;
if (!STRATEGIES.includes(strategy)) {
  console.error(`STRATEGY must be one of: ${STRATEGIES.join(", ")}`);
  process.exit(2);
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const server = createProxy({
  upstream: upstreamRaw.split(",").map((u) => new URL(u.trim())),
  strategy,
  trustForwarded: process.env.TRUST_FORWARDED === "true",
  upstreamTimeoutMs: process.env.UPSTREAM_TIMEOUT_MS ? Number(process.env.UPSTREAM_TIMEOUT_MS) : undefined,
  log: (entry) => console.log(JSON.stringify(entry)),
});

server.listen(port, host, () => console.log(JSON.stringify({ msg: "listening", host, port, strategy, upstream: upstreamRaw })));

// Graceful shutdown: stop accepting, let in-flight requests finish, drop idle keep-alive sockets.
function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
