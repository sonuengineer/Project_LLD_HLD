import { describe, expect, it } from "vitest";
import { Bulkhead } from "../src/bulkhead.js";
import { BulkheadRejectedError } from "../src/errors.js";

const flush = () => new Promise((r) => setImmediate(r));

// Operations the test finishes by hand, recording the order they STARTED in.
function controllable() {
  const started: string[] = [];
  const finish = new Map<string, { ok: () => void; fail: () => void }>();
  const promises = new Map<string, Promise<string>>();
  const op = (name: string) => () => {
    const p = new Promise<string>((resolve, reject) => {
      started.push(name);
      finish.set(name, { ok: () => resolve(name), fail: () => reject(new Error(`${name} failed`)) });
    });
    promises.set(name, p);
    return p;
  };
  return { op, started, finish: (name: string) => finish.get(name)!, promise: (name: string) => promises.get(name)! };
}

describe("Bulkhead", () => {
  it("runs at most maxConcurrent at once; with no queue the next call is rejected without running", async () => {
    const b = new Bulkhead({ maxConcurrent: 2 });
    const c = controllable();
    const p1 = b.execute(c.op("a"));
    const p2 = b.execute(c.op("b"));
    const e = await b.execute(c.op("c")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BulkheadRejectedError);
    expect(e).toMatchObject({ maxConcurrent: 2, maxQueue: 0 });
    expect(c.started).toEqual(["a", "b"]);
    expect([b.running, b.queued]).toEqual([2, 0]);
    c.finish("a").ok();
    c.finish("b").ok();
    expect(await Promise.all([p1, p2])).toEqual(["a", "b"]);
    expect(b.running).toBe(0);
  });

  it("queues up to maxQueue in FIFO order, then rejects", async () => {
    const b = new Bulkhead({ maxConcurrent: 1, maxQueue: 2 });
    const c = controllable();
    const all = ["a", "b", "c"].map((n) => b.execute(c.op(n)));
    await expect(b.execute(c.op("d"))).rejects.toBeInstanceOf(BulkheadRejectedError);
    expect([b.running, b.queued]).toEqual([1, 2]);
    c.finish("a").ok();
    await flush();
    c.finish("b").ok();
    await flush();
    c.finish("c").ok();
    expect(await Promise.all(all)).toEqual(["a", "b", "c"]);
    expect(c.started).toEqual(["a", "b", "c"]);
  });

  it("a failing or synchronously throwing call still frees its slot", async () => {
    const b = new Bulkhead({ maxConcurrent: 1 });
    await expect(b.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(
      b.execute(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(b.running).toBe(0);
    expect(await b.execute(async () => "free")).toBe("free");
  });

  it("no barging: a newcomer arriving right after the slot is released goes behind the waiter", async () => {
    const b = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    const c = controllable();
    const pa = b.execute(c.op("a"));
    const pw = b.execute(c.op("waiter"));
    // The bulkhead awaits a's promise first, so its release runs first; this reaction runs right after it,
    // BEFORE the waiter's continuation. If release dropped the running count and let the waiter re-take the slot
    // when it wakes up, the newcomer would see a free slot here and start ahead of the waiter.
    let newcomer: Promise<string> | undefined;
    void c.promise("a").then(() => {
      newcomer = b.execute(c.op("newcomer"));
    });
    c.finish("a").ok();
    await pa;
    await flush();
    expect(c.started).toEqual(["a", "waiter"]);
    expect(b.queued).toBe(1); // the newcomer waits
    c.finish("waiter").ok();
    await pw;
    await flush();
    expect(c.started).toEqual(["a", "waiter", "newcomer"]);
    c.finish("newcomer").ok();
    expect(await newcomer).toBe("newcomer");
  });

  it("a queued caller that aborts leaves the queue, never runs, and its place is free", async () => {
    const b = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    const c = controllable();
    const pa = b.execute(c.op("a"));
    const ctrl = new AbortController();
    const pq = b.execute(c.op("quitter"), ctrl.signal).catch((e: unknown) => e);
    expect(b.queued).toBe(1);
    ctrl.abort(new Error("gave up waiting"));
    expect(await pq).toMatchObject({ message: "gave up waiting" });
    expect(b.queued).toBe(0);
    const pb = b.execute(c.op("b")); // takes the freed queue place
    c.finish("a").ok();
    await pa;
    await flush();
    expect(c.started).toEqual(["a", "b"]);
    c.finish("b").ok();
    await pb;
  });

  it("a waiter aborted right after its slot was handed over does not run, and passes the slot on", async () => {
    const b = new Bulkhead({ maxConcurrent: 1, maxQueue: 2 });
    const c = controllable();
    const pa = b.execute(c.op("a"));
    const ctrl = new AbortController();
    const pw = b.execute(c.op("waiter"), ctrl.signal).catch((e: unknown) => e);
    const pn = b.execute(c.op("next"));
    // Runs after the bulkhead released a's slot to the waiter, before the waiter wakes up (reaction order).
    void c.promise("a").then(() => ctrl.abort(new Error("gave up")));
    c.finish("a").ok();
    await pa;
    expect(await pw).toMatchObject({ message: "gave up" });
    await flush();
    expect(c.started).toEqual(["a", "next"]); // the waiter never ran; the slot went on
    c.finish("next").ok();
    await pn;
    expect([b.running, b.queued]).toEqual([0, 0]);
  });

  it("a waiter that gets its slot removes its abort listener from the caller's signal (no leak)", async () => {
    const b = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    const c = controllable();
    const pa = b.execute(c.op("a"));
    const ctrl = new AbortController();
    const s = ctrl.signal;
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const add = s.addEventListener.bind(s);
    const remove = s.removeEventListener.bind(s);
    s.addEventListener = ((type: string, fn: never, o?: never) => (added.push(fn), add(type, fn, o))) as never;
    s.removeEventListener = ((type: string, fn: never, o?: never) => (removed.push(fn), remove(type, fn, o))) as never;
    const pw = b.execute(c.op("waiter"), s);
    expect(added).toHaveLength(1);
    c.finish("a").ok();
    await pa;
    await flush();
    expect(removed).toEqual(added); // removed at hand-off, not left behind for the life of the signal
    c.finish("waiter").ok();
    await pw;
  });

  it("an already-aborted caller is refused before taking a slot", async () => {
    const b = new Bulkhead({ maxConcurrent: 1 });
    await expect(b.execute(async () => "x", AbortSignal.abort(new Error("no")))).rejects.toThrow("no");
    expect(b.running).toBe(0);
  });

  it("the operation gets the caller's signal", async () => {
    const b = new Bulkhead({ maxConcurrent: 1 });
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    await b.execute(async (s) => void (seen = s), ctrl.signal);
    expect(seen).toBe(ctrl.signal);
  });

  it("random load: never more than maxConcurrent running, every accepted call runs exactly once", async () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const b = new Bulkhead({ maxConcurrent: 3, maxQueue: 4 });
    let running = 0;
    let peak = 0;
    const runs = new Map<number, number>();
    const pending: (() => void)[] = [];
    const results: Promise<string>[] = [];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 400; i++) {
      if (rand() < 0.55) {
        const id = i;
        const p = b.execute(
          () =>
            new Promise<void>((resolve) => {
              running++;
              peak = Math.max(peak, running);
              runs.set(id, (runs.get(id) ?? 0) + 1);
              pending.push(() => {
                running--;
                resolve();
              });
            }),
        );
        results.push(
          p.then(
            () => "ok",
            (e: unknown) => (e instanceof BulkheadRejectedError ? "rejected" : "other"),
          ),
        );
      } else if (pending.length > 0) {
        pending.splice(Math.floor(rand() * pending.length), 1)[0]!();
      }
      await flush();
      expect(running).toBeLessThanOrEqual(3);
      expect(b.running).toBe(running);
    }
    while (pending.length > 0) {
      pending.shift()!();
      await flush();
    }
    for (const r of await Promise.all(results)) {
      if (r === "ok") accepted++;
      else if (r === "rejected") rejected++;
      else throw new Error("unexpected error");
    }
    expect(peak).toBe(3);
    expect(rejected).toBeGreaterThan(0);
    expect(runs.size).toBe(accepted);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    expect([b.running, b.queued]).toEqual([0, 0]);
  });

  it.each([[{ maxConcurrent: 0 }], [{ maxConcurrent: 1.5 }], [{ maxConcurrent: 1, maxQueue: -1 }]])("rejects %j", (opts) => {
    expect(() => new Bulkhead(opts)).toThrow(RangeError);
  });
});
