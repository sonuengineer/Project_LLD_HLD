import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { gracefulShutdown } from "../src/shutdown.js";

/** In-process tests: no signals, so they run on every OS (the real-process version is in shutdown.test.ts). */
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

function serve(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

/** A client that keeps its connection open after the response, like browsers and most HTTP clients do. */
const keepAlive = () => new http.Agent({ keepAlive: true });

function get(port: number, path: string, agent: http.Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

describe("gracefulShutdown", () => {
  it("closes at once when nothing is connected", async () => {
    const { server } = await serve((_q, r) => r.end("x"));
    const t0 = Date.now();
    expect(await gracefulShutdown(server)).toBe("closed");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("lets an in-flight request finish, then closes quickly even though the client keeps its connection open", async () => {
    let arrived: () => void = () => undefined;
    const reached = new Promise<void>((r) => (arrived = r));
    const { server, port } = await serve((_q, res) => {
      arrived();
      setTimeout(() => res.end("finished"), 300);
    });
    const agent = keepAlive();
    const inFlight = get(port, "/", agent);
    await reached;
    const t0 = Date.now();
    const shutdown = gracefulShutdown(server, { sweepMs: 20 });
    expect(await inFlight).toBe("finished"); // not cut off
    expect(await shutdown).toBe("closed");
    // without the sweep this waits for the keep-alive timeout (5 s by default); with it, well under 1.5 s
    expect(Date.now() - t0).toBeLessThan(1500);
    agent.destroy();
  });

  it("stops accepting new connections once shutdown has begun", async () => {
    const { server, port } = await serve((_q, res) => setTimeout(() => res.end("ok"), 200));
    const agent = keepAlive();
    const inFlight = get(port, "/", agent);
    await new Promise((r) => setTimeout(r, 50));
    const shutdown = gracefulShutdown(server, { sweepMs: 20 });
    await expect(get(port, "/", new http.Agent({ keepAlive: false }))).rejects.toThrow();
    await inFlight;
    await shutdown;
    agent.destroy();
  });

  it("reports 'forced' when a request is still running after forceMs", async () => {
    const { server, port } = await serve(() => undefined); // never answers
    const agent = keepAlive();
    void get(port, "/", agent).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    expect(await gracefulShutdown(server, { forceMs: 300, sweepMs: 20 })).toBe("forced");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    agent.destroy();
  });
});
