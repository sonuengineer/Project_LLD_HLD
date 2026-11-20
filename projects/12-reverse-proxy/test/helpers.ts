import http from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy } from "../src/proxy.js";
import type { ProxyOptions } from "../src/proxy.js";

const open: http.Server[] = [];

export async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  return (server.address() as AddressInfo).port;
}

export async function closeAll(): Promise<void> {
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

/** An upstream that answers every request with a JSON description of what it received. */
export function echoUpstream(): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      res.setHeader("content-type", "application/json");
      res.setHeader("x-upstream", "echo");
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, bodyLength: body.length, body: body.toString("utf8").slice(0, 200) }));
    });
  });
}

export async function startProxy(upstreamPort: number | number[], extra: Partial<ProxyOptions> = {}): Promise<number> {
  const ports = Array.isArray(upstreamPort) ? upstreamPort : [upstreamPort];
  const proxy = createProxy({ upstream: ports.map((p) => new URL(`http://127.0.0.1:${p}`)), ...extra });
  return listen(proxy);
}

/** An upstream that answers every request with its own name. */
export function namedUpstream(name: string): http.Server {
  return http.createServer((_req, res) => {
    res.end(name);
  });
}

/** A port that nothing listens on (bind, read the port, close). */
export async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
