#!/usr/bin/env node
/**
 * CLI entry point. All settings come from environment variables:
 *
 *   HOST                 default 127.0.0.1
 *   PORT                 default 4222
 *   MAX_PAYLOAD          bytes, default 1048576
 *   PING_INTERVAL_MS     default 120000
 *   MAX_PINGS_OUT        default 2
 *   MAX_PENDING          bytes queued for one client before it is dropped as a slow consumer, default 67108864
 *   CLUSTER_PORT         port for routes from other brokers; unset = no cluster
 *   CLUSTER_HOST         default: same as HOST
 *   ROUTES               comma list of peers to dial, host:port each (every node may list every other one)
 *   ROUTE_RECONNECT_MS   first re-dial delay, doubles up to 32x, default 1000
 *   STATS_INTERVAL_MS    if set, print one JSON stats line (counters + RSS) per interval; 0 or unset = off
 *   ALLOW_NON_LOOPBACK   must be "1" to bind anything but loopback (client OR cluster address). There is NO
 *                        authentication yet, so only ever bind a PRIVATE address, never a public one.
 */
import { Broker, type ClusterOptions } from "./server.js";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    console.error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return Number(raw);
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";
const host = process.env.HOST || "127.0.0.1";
const clusterHost = process.env.CLUSTER_HOST || host;
for (const h of [host, ...(process.env.CLUSTER_PORT ? [clusterHost] : [])]) {
  if (!isLoopback(h) && process.env.ALLOW_NON_LOOPBACK !== "1") {
    console.error(`refusing to bind ${h}: the broker has no authentication. Set ALLOW_NON_LOOPBACK=1 only for a private address.`);
    process.exit(2);
  }
}

let cluster: ClusterOptions | undefined;
if (process.env.CLUSTER_PORT) {
  cluster = {
    host: clusterHost,
    port: intEnv("CLUSTER_PORT", 0),
    routes: (process.env.ROUTES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    reconnectMs: intEnv("ROUTE_RECONNECT_MS", 1000),
  };
}

const broker = new Broker({
  host,
  port: intEnv("PORT", 4222),
  maxPayload: intEnv("MAX_PAYLOAD", 1024 * 1024),
  pingIntervalMs: intEnv("PING_INTERVAL_MS", 120_000),
  maxPingsOut: intEnv("MAX_PINGS_OUT", 2),
  maxPending: intEnv("MAX_PENDING", 64 * 1024 * 1024),
  cluster,
});

const addr = await broker.listen();
console.log(JSON.stringify({ event: "listening", ...addr, serverId: broker.serverId }));

const statsMs = intEnv("STATS_INTERVAL_MS", 0);
if (statsMs > 0) {
  setInterval(() => {
    console.log(JSON.stringify({ event: "stats", t: Date.now(), rssKiB: Math.round(process.memoryUsage().rss / 1024), ...broker.stats() }));
  }, statsMs).unref();
}

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "stopping", signal, ...broker.stats() }));
  void broker.close().then((how) => {
    console.log(JSON.stringify({ event: "stopped", how }));
    process.exit(0);
  });
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
