// The "client already gone" paths of the HTTP helpers, with a fake response object so they are observable (over a
// real socket, writing to a closed connection is silently dropped -- which is why mutations C4, E1 and E2 survived
// the real-app tests).
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { cachedJson } from "../src/adapters/express.js";
import { requestSignal } from "../src/adapters/http.js";
import { LruCache } from "../src/cache.js";

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
  return res as unknown as ServerResponse & typeof res;
}
const req = {} as IncomingMessage;
const tick = () => new Promise((r) => setImmediate(r));

describe("requestSignal", () => {
  it("aborts when the connection closes before the response finished", () => {
    const res = fakeRes();
    const s = requestSignal(res);
    res.emit("close");
    expect(s.aborted).toBe(true);
  });

  it("does NOT abort on the normal close after a finished response", () => {
    const res = fakeRes();
    const s = requestSignal(res);
    res.writableFinished = true;
    res.emit("close");
    expect(s.aborted).toBe(false);
  });
});

describe("cachedJson when the client is gone", () => {
  it("writes nothing to a response that was destroyed while the load ran", async () => {
    let finish: (v: string) => void = () => {};
    const handler = cachedJson(new LruCache<string, string>({ maxEntries: 10 }), { key: () => "k" }, () => new Promise<string>((r) => (finish = r)));
    const res = fakeRes();
    const next = vi.fn();
    handler(req, res, next);
    await tick();
    res.destroyed = true; // e.g. the socket was destroyed, without (yet) a close event
    finish("late");
    await tick();
    await tick();
    expect(res.end).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next(err) for a client that has gone", async () => {
    let fail: (e: Error) => void = () => {};
    const handler = cachedJson(new LruCache<string, string>({ maxEntries: 10 }), { key: () => "k2" }, () => new Promise<string>((_r, j) => (fail = j)));
    const res = fakeRes();
    const next = vi.fn();
    handler(req, res, next);
    await tick();
    res.emit("close"); // client gone before the answer: its wait is aborted
    fail(new Error("db down"));
    await tick();
    await tick();
    expect(next).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
