import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ioredisL2Client, ioredisSubscriber } from "../src/index.js";
import { deferred, flush } from "./support.js";

// The ioredis adapters against hand-made stand-ins, for the ordering rules a real Redis cannot show reliably
// (redis-l2.test.ts covers them against a real server).

function fakeSub() {
  const em = new EventEmitter();
  const calls: string[] = [];
  let next = deferred<unknown>();
  const sub = {
    subscribe: vi.fn((ch: string) => (calls.push(`subscribe ${ch}`), next.promise)),
    unsubscribe: vi.fn(async (ch: string) => void calls.push(`unsubscribe ${ch}`)),
    on: (e: string, f: (...a: any[]) => void) => em.on(e, f),
    off: (e: string, f: (...a: any[]) => void) => em.off(e, f),
  };
  return { em, sub, calls, answer: () => { next.resolve(1); next = deferred<unknown>(); }, fail: (e: Error) => next.reject(e) };
}

describe("ioredisSubscriber", () => {
  it("passes on messages for its channel only", async () => {
    const f = fakeSub();
    const got: string[] = [];
    const p = ioredisSubscriber(f.sub).subscribe("ch", (m) => got.push(m), () => {});
    f.answer();
    await p;
    f.em.emit("message", "ch", "a");
    f.em.emit("message", "other", "b");
    expect(got).toEqual(["a"]);
  });

  it("a 'ready' before the first subscribe completed is ignored; after a reconnect, onResubscribed runs only once Redis CONFIRMED the new SUBSCRIBE", async () => {
    const f = fakeSub();
    const resub = vi.fn();
    const p = ioredisSubscriber(f.sub).subscribe("ch", () => {}, resub);
    f.em.emit("ready"); // the initial connect
    f.answer();
    await p;
    expect(resub).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["subscribe ch"]);
    f.em.emit("ready"); // a reconnect
    expect(f.calls).toEqual(["subscribe ch", "subscribe ch"]);
    await flush();
    expect(resub).not.toHaveBeenCalled(); // not yet: the SUBSCRIBE is not confirmed
    f.answer();
    await flush();
    expect(resub).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes the listeners; a failed first subscribe removes them too and rejects", async () => {
    const f = fakeSub();
    const p = ioredisSubscriber(f.sub).subscribe("ch", () => {}, () => {});
    f.answer();
    const unsubscribe = await p;
    await unsubscribe();
    expect(f.em.listenerCount("message") + f.em.listenerCount("ready")).toBe(0);
    expect(f.calls).toContain("unsubscribe ch");
    const g = fakeSub();
    const q = ioredisSubscriber(g.sub).subscribe("ch", () => {}, () => {});
    g.fail(new Error("NOPERM"));
    await expect(q).rejects.toThrow("NOPERM");
    expect(g.em.listenerCount("message") + g.em.listenerCount("ready")).toBe(0);
  });
});

describe("ioredisL2Client", () => {
  const multiOf = (replies: Array<[Error | null, unknown]> | null) => {
    const m = { get: () => m, pttl: () => m, exec: async () => replies };
    return m;
  };
  const base = { set: async () => "OK", publish: async () => 1 };

  it("an error inside the MULTI reply, or an aborted MULTI, is an error (not a miss)", async () => {
    await expect(ioredisL2Client({ ...base, multi: () => multiOf([[new Error("WRONGTYPE"), null], [null, 5]]) }).getWithTtl("k")).rejects.toThrow("WRONGTYPE");
    await expect(ioredisL2Client({ ...base, multi: () => multiOf([[null, "v"], [new Error("TTL broke"), null]]) }).getWithTtl("k")).rejects.toThrow("TTL broke");
    await expect(ioredisL2Client({ ...base, multi: () => multiOf(null) }).getWithTtl("k")).rejects.toThrow(/aborted/);
    expect(await ioredisL2Client({ ...base, multi: () => multiOf([[null, "v"], [null, 42]]) }).getWithTtl("k")).toEqual(["v", 42]);
  });

  it("set maps ttl / NX to the right SET arguments", async () => {
    const seen: unknown[][] = [];
    const client = { multi: () => multiOf([]), publish: async () => 1, set: async (...a: unknown[]) => (seen.push(a), "OK") };
    const l2 = ioredisL2Client(client as never);
    await l2.set("k", "v", undefined, false);
    await l2.set("k", "v", undefined, true);
    await l2.set("k", "v", 5, false);
    await l2.set("k", "v", 5, true);
    expect(seen).toEqual([["k", "v"], ["k", "v", "NX"], ["k", "v", "PX", 5], ["k", "v", "PX", 5, "NX"]]);
  });
});
