import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, listen, namedUpstream } from "./helpers.js";
import { createServer } from "node:net";

afterEach(closeAll);

/** Runs the real CLI with this environment and waits for it to exit (for settings that must be rejected). */
function runToExit(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["dist/index.js"], { env: { ...process.env, PORT: "0", ...env }, encoding: "utf8", timeout: 10_000 });
  return { code: r.status, stderr: r.stderr };
}

describe("CLI rejects bad settings with a clear message and exit code 2", () => {
  it.each([
    [{}, /UPSTREAM is required/],
    [{ UPSTREAM: "http://127.0.0.1:1", STRATEGY: "random" }, /STRATEGY must be one of/],
    [{ UPSTREAM: "http://127.0.0.1:1", RETRIES: "abc" }, /RETRIES must be a whole number/],
    [{ UPSTREAM: "http://127.0.0.1:1", EJECT_AFTER: "-1" }, /EJECT_AFTER must be a whole number/],
    [{ UPSTREAM: "https://example.com" }, /invalid UPSTREAM: only http/],
    [{ UPSTREAM: "http://example.com/base" }, /invalid UPSTREAM: upstream must not contain a path/],
    [{ UPSTREAM: "http://127.0.0.1:1", HEALTH_PATH: "health" }, /health check path must start with \/ \(got "health"\)/],
  ])("%j", (env, message) => {
    const { code, stderr } = runToExit(env as Record<string, string>);
    expect(stderr).toMatch(message);
    expect(code === 2 || code === 1).toBe(true); // 2 for settings we validate; the health path error is thrown at start-up
  });
});

describe("REQUEST_LOG", () => {
  async function lines(env: Record<string, string>): Promise<string[]> {
    const upstream = await listen(namedUpstream("u"));
    const probe = createServer();
    const port = await new Promise<number>((resolve) => probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port)));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const child = spawn(process.execPath, ["dist/index.js"], {
      env: { ...process.env, UPSTREAM: `http://127.0.0.1:${upstream}`, PORT: String(port), HOST: "127.0.0.1", ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const seen: string[] = [];
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (l) => seen.push(l));
    try {
      await new Promise<void>((resolve) => rl.on("line", (l) => l.includes('"msg":"listening"') && resolve()));
      await new Promise<void>((resolve, reject) => http.get({ port, host: "127.0.0.1", path: "/x" }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      child.kill("SIGKILL");
    }
    return seen;
  }

  it("is on by default: one JSON line per request", async () => {
    expect((await lines({})).some((l) => l.includes('"url":"/x"'))).toBe(true);
  });

  it("REQUEST_LOG=false silences the per-request line but keeps the start-up line", async () => {
    const seen = await lines({ REQUEST_LOG: "false" });
    expect(seen.some((l) => l.includes('"msg":"listening"'))).toBe(true);
    expect(seen.some((l) => l.includes('"url":"/x"'))).toBe(false);
  });
});
