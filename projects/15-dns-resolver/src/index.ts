#!/usr/bin/env node
/**
 * CLI.
 *
 *   node dist/index.js                      serve stub clients on HOST:PORT (UDP + TCP)
 *   node dist/index.js resolve <name> [type] resolve once from the root servers, print every step and the answer
 *
 * Environment:
 *   HOST                default 127.0.0.1
 *   PORT                default 5300
 *   TIMEOUT_MS          per upstream query, default 2000
 *   TRACE               "1" = print every upstream query while serving
 *   ALLOW_NON_LOOPBACK  must be "1" to bind anything but loopback. This is an open recursive resolver with no
 *                       access control and no rate limit: never bind a public address.
 */
import { Resolver } from "./resolver.js";
import { DnsServer, isLoopback } from "./server.js";
import { TYPE, formatRecord, rcodeName } from "./wire.js";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    console.error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return Number(raw);
}

function parseType(s: string | undefined): number {
  if (!s) return TYPE.A;
  const known = (TYPE as Record<string, number>)[s.toUpperCase()];
  if (known !== undefined) return known;
  const m = /^TYPE(\d+)$/i.exec(s);
  if (m && Number(m[1]) < 65536) return Number(m[1]);
  console.error(`unknown type ${s}; use A, AAAA, NS, CNAME, SOA, MX, TXT, PTR or TYPEnnn`);
  process.exit(2);
}

const timeoutMs = intEnv("TIMEOUT_MS", 2000);
const [cmd, name, type] = process.argv.slice(2);

if (cmd === "resolve") {
  if (!name) {
    console.error("usage: resolve <name> [type]");
    process.exit(2);
  }
  const resolver = new Resolver({ timeoutMs, trace: (l) => console.log(l) });
  const started = Date.now();
  const r = await resolver.resolve(name.replace(/\.$/, ""), parseType(type));
  console.log(`\n;; ${rcodeName(r.rcode)}, ${r.queries} upstream queries, ${Date.now() - started} ms${r.reason ? ` (${r.reason})` : ""}`);
  for (const rr of r.answers) console.log(formatRecord(rr));
  for (const rr of r.authority) console.log(`;; authority: ${formatRecord(rr)}`);
  process.exit(0);
} else if (cmd !== undefined) {
  console.error(`unknown command ${cmd}; run without arguments to serve, or "resolve <name> [type]"`);
  process.exit(2);
}

const host = process.env.HOST || "127.0.0.1";
if (!isLoopback(host) && process.env.ALLOW_NON_LOOPBACK !== "1") {
  console.error(`refusing to bind ${host}: open recursive resolver, no access control. Set ALLOW_NON_LOOPBACK=1 only on a private network.`);
  process.exit(2);
}
const trace = process.env.TRACE === "1" ? (l: string) => console.log(l) : undefined;
const server = new DnsServer({
  resolver: new Resolver({ timeoutMs, trace }),
  host,
  port: intEnv("PORT", 5300),
  allowNonLoopback: process.env.ALLOW_NON_LOOPBACK === "1",
});
const addr = await server.listen();
console.log(JSON.stringify({ event: "listening", ...addr }));
console.log(`try: dig @${addr.host} -p ${addr.port} example.com   (Windows nslookup ignores -port; run with PORT=53 for it)`);

const stop = (signal: string) => {
  console.log(JSON.stringify({ event: "stopping", signal, ...server.stats() }));
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
