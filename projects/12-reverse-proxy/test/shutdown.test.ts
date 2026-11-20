import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import http from "node:http";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, listen } from "./helpers.js";
import { createServer } from "node:net";

/**
 * These tests start the real CLI (dist/index.js) as its own process and send it SIGTERM.
 * Windows cannot deliver SIGTERM to a Node process as a catchable signal (it just kills it),
 * so they only run on Linux and macOS.
 */
const run = process.platform === "win32" ? describe.skip : describe;

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await closeAll();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function startCli(upstreamPort: number): Promise<{ child: ChildProcess; port: number; exited: Promise<number | null> }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, UPSTREAM: `http://127.0.0.1:${upstreamPort}`, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => line.includes('"msg":"listening"') && resolve());
    child.once("exit", () => reject(new Error("CLI exited before it was listening")));
  });
  return { child, port, exited };
}

run("graceful shutdown of the real process", () => {
  it("lets an in-flight request finish, then exits with code 0 and stops accepting", async () => {
    let reachedUpstream: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (reachedUpstream = resolve));
    const slow = http.createServer((_q, res) => {
      reachedUpstream();
      setTimeout(() => res.end("finished"), 700);
    });
    const { child, port, exited } = await startCli(await listen(slow));

    const inFlight = fetch(`http://127.0.0.1:${port}/`).then(async (r) => ({ status: r.status, body: await r.text() }));
    await arrived;
    child.kill("SIGTERM");

    expect(await inFlight).toEqual({ status: 200, body: "finished" }); // not cut off by the shutdown
    expect(await exited).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(); // nothing listens any more
  });

  it("does not wait for idle keep-alive connections", async () => {
    const quick = http.createServer((_q, res) => res.end("hi"));
    const { child, port, exited } = await startCli(await listen(quick));
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200); // leaves an idle keep-alive socket
    const started = Date.now();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000); // the 10 s force-exit timer must not be what ended it
  });
});
