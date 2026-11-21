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
 *   ALLOW_NON_LOOPBACK   must be "1" to bind anything but loopback. There is NO authentication yet, so only ever
 *                        bind a PRIVATE address, never a public one.
 */
import { Broker } from "./server.js";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    console.error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return Number(raw);
}

const host = process.env.HOST || "127.0.0.1";
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
if (!loopback && process.env.ALLOW_NON_LOOPBACK !== "1") {
  console.error(`refusing to bind ${host}: the broker has no authentication. Set ALLOW_NON_LOOPBACK=1 only for a private address.`);
  process.exit(2);
}

const broker = new Broker({
  host,
  port: intEnv("PORT", 4222),
  maxPayload: intEnv("MAX_PAYLOAD", 1024 * 1024),
  pingIntervalMs: intEnv("PING_INTERVAL_MS", 120_000),
  maxPingsOut: intEnv("MAX_PINGS_OUT", 2),
  maxPending: intEnv("MAX_PENDING", 64 * 1024 * 1024),
});

const addr = await broker.listen();
console.log(JSON.stringify({ event: "listening", ...addr, serverId: broker.serverId }));

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
