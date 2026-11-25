// startServer: the API and a worker in one process, real timers, clean shutdown.
import { describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { createApp } from "../src/http/app.js";
import { startServer } from "../src/http/server.js";
import { Worker } from "../src/worker.js";
import { gate } from "./helpers.js";
import { setupQueued } from "./queued-helpers.js";

const KEY = "test-key-0123456789abcdef";

async function until(check: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("startServer", () => {
  it("serves, its worker sends; close() waits for the send in progress, then the port is closed", async () => {
    const s = setupQueued({ clock: systemClock });
    const slow = gate<{ status: "sent"; providerId: string }>();
    s.push.willAnswer(() => slow.promise);
    const running = await startServer(
      createApp({ notifier: s.notifier, users: s.users, preferences: s.preferences, apiKey: KEY }),
      new Worker(s.notifier, { pollMs: 10 }),
      { port: 0, host: "127.0.0.1" },
    );
    const res = await fetch(`${running.url}/notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "idempotency-key": "k1", "content-type": "application/json" },
      body: JSON.stringify({ typeId: "otp", userId: "u1", data: { code: "1" } }),
    });
    const { id } = await res.json();
    await until(() => s.push.attempts.length === 1); // the worker is sending

    let closed = false;
    const closing = running.close().then(() => (closed = true));
    expect(running.close()).toBe(running.close()); // one shutdown, however often it is asked for
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(false); // still waiting for the send
    slow.resolve({ status: "sent", providerId: "p1" });
    await closing;
    expect(s.notifier.get(id)!.deliveries[0]!.status).toBe("sent");
    await expect(fetch(`${running.url}/notifications/${id}`)).rejects.toThrow();
  });

  it("a port already in use rejects instead of crashing", async () => {
    const s = setupQueued({ clock: systemClock });
    const app = createApp({ notifier: s.notifier, users: s.users, preferences: s.preferences, apiKey: KEY });
    const first = await startServer(app, new Worker(s.notifier, { pollMs: 10 }), { port: 0, host: "127.0.0.1" });
    const port = Number(new URL(first.url).port);
    await expect(startServer(app, new Worker(s.notifier, { pollMs: 10 }), { port, host: "127.0.0.1" })).rejects.toThrow(/EADDRINUSE/);
    await first.close();
  });
});
