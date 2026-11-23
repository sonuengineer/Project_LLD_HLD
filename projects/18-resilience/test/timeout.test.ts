import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError } from "../src/errors.js";
import { sleep } from "../src/sleep.js";
import { TimeoutPolicy } from "../src/timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

// An operation that never finishes on its own and records whether its signal was aborted.
function hanging() {
  const seen: { signal?: AbortSignal } = {};
  const op = (signal: AbortSignal) => {
    seen.signal = signal;
    return new Promise<string>(() => {});
  };
  return { op, seen };
}

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    let done = false;
    void sleep(100).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("rejects at once with the abort reason, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const p = sleep(10_000, c.signal);
    c.abort(new Error("bye"));
    await expect(p).rejects.toThrow("bye");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects without waiting if already aborted", async () => {
    await expect(sleep(10_000, AbortSignal.abort(new Error("already")))).rejects.toThrow("already");
  });
});

describe("TimeoutPolicy", () => {
  it("returns the result of a fast operation and clears its timer", async () => {
    vi.useFakeTimers();
    const t = new TimeoutPolicy({ ms: 1000 });
    expect(await t.execute(async () => 42)).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the operation's own error through", async () => {
    const t = new TimeoutPolicy({ ms: 1000 });
    await expect(t.execute(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(
      t.execute(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
  });

  it("times out: rejects with TimeoutError AND aborts the operation's signal with it", async () => {
    vi.useFakeTimers();
    const { op, seen } = hanging();
    const p = new TimeoutPolicy({ ms: 500 }).execute(op).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(seen.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await p;
    expect(e).toBeInstanceOf(TimeoutError);
    expect((e as TimeoutError).timeoutMs).toBe(500);
    expect(seen.signal!.aborted).toBe(true);
    expect(seen.signal!.reason).toBe(e);
  });

  it("rejects on timeout even if the operation ignores its signal", async () => {
    vi.useFakeTimers();
    const p = new TimeoutPolicy({ ms: 100 }).execute(() => new Promise(() => {})).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBeInstanceOf(TimeoutError);
  });

  it("a late answer after the timeout changes nothing", async () => {
    vi.useFakeTimers();
    let finish: (v: string) => void = () => {};
    const p = new TimeoutPolicy({ ms: 100 }).execute(() => new Promise<string>((r) => (finish = r))).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    finish("too late");
    expect(await p).toBeInstanceOf(TimeoutError);
  });

  it("the caller's abort stops it at once with the caller's reason and aborts the operation's signal", async () => {
    vi.useFakeTimers();
    const { op, seen } = hanging();
    const caller = new AbortController();
    const p = new TimeoutPolicy({ ms: 10_000 }).execute(op, caller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    caller.abort(new Error("client went away"));
    const e = await p;
    expect(e).toMatchObject({ message: "client went away" });
    expect(seen.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted caller signal: the operation is never called", async () => {
    let called = false;
    const op = async () => {
      called = true;
    };
    await expect(new TimeoutPolicy({ ms: 100 }).execute(op, AbortSignal.abort(new Error("no")))).rejects.toThrow("no");
    expect(called).toBe(false);
  });

  it("removes its listener from the caller's signal (no leak across many calls)", async () => {
    const caller = new AbortController();
    const t = new TimeoutPolicy({ ms: 1000 });
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const s = caller.signal;
    const add = s.addEventListener.bind(s);
    const remove = s.removeEventListener.bind(s);
    s.addEventListener = ((type: string, fn: never, o?: never) => (added.push(fn), add(type, fn, o))) as never;
    s.removeEventListener = ((type: string, fn: never, o?: never) => (removed.push(fn), remove(type, fn, o))) as never;
    for (let i = 0; i < 5; i++) await t.execute(async () => i, s);
    expect(added).toHaveLength(5);
    expect(removed).toEqual(added);
  });

  it.each([0, -1, Number.NaN, Infinity])("rejects ms = %s", (ms) => {
    expect(() => new TimeoutPolicy({ ms })).toThrow(RangeError);
  });
});
