// Exhaustive tests for the single most important invariant in this project (see replay-window.ts's header
// comment). Pure data structure, no crypto, no networking -- every case is deterministic and instant.
import { describe, expect, it } from "vitest";
import { AntiReplayWindow } from "../src/replay-window.js";

describe("AntiReplayWindow", () => {
  it("accepts counters 0, 1, 2, ... in order", () => {
    const w = new AntiReplayWindow(64);
    for (let i = 0; i < 10; i++) {
      expect(w.check(i)).toBe("ACCEPT");
      w.record(i);
    }
  });

  it("rejects an exact replay of the counter just accepted", () => {
    const w = new AntiReplayWindow(64);
    expect(w.check(5)).toBe("ACCEPT");
    w.record(5);
    expect(w.check(5)).toBe("REPLAY");
  });

  it("rejects an exact replay of an older, still-in-window counter", () => {
    const w = new AntiReplayWindow(64);
    for (const c of [0, 1, 2, 3, 4]) w.record(c);
    expect(w.check(2)).toBe("REPLAY");
  });

  it("accepts out-of-order counters within the window, each exactly once", () => {
    const w = new AntiReplayWindow(64);
    const order = [0, 3, 1, 2, 5, 4];
    for (const c of order) {
      expect(w.check(c)).toBe("ACCEPT");
      w.record(c);
    }
    for (const c of order) expect(w.check(c)).toBe("REPLAY");
  });

  it("rejects a counter far enough behind the highest to be outside the window", () => {
    const w = new AntiReplayWindow(64);
    w.record(1000);
    expect(w.check(1000 - 64)).toBe("TOO_OLD"); // exactly size-behind: outside (window is the 64 most recent)
    expect(w.check(1000 - 63)).toBe("ACCEPT"); // one slot further in: still inside
  });

  it("the boundary is exact: highest - size is too old, highest - size + 1 is the oldest acceptable", () => {
    const size = 32;
    const w = new AntiReplayWindow(size);
    w.record(500);
    expect(w.check(500 - size)).toBe("TOO_OLD");
    expect(w.check(500 - size + 1)).toBe("ACCEPT");
  });

  it("never-before-seen counter 0 on a fresh window is accepted (the -1 sentinel does not look like a real counter)", () => {
    const w = new AntiReplayWindow(64);
    expect(w.check(0)).toBe("ACCEPT");
  });

  it("rejects negative and non-integer counters unconditionally", () => {
    const w = new AntiReplayWindow(64);
    expect(w.check(-1)).toBe("TOO_OLD");
    expect(w.check(1.5)).toBe("TOO_OLD");
    expect(w.check(Number.NaN)).toBe("TOO_OLD");
  });

  it("sliding the window forward clears stale bits so a slot can be reused correctly", () => {
    const size = 8;
    const w = new AntiReplayWindow(size);
    for (let i = 0; i < size; i++) w.record(i); // fills every slot once, bits 0..7 all set
    // Advance far past the whole window in one jump; every slot gets reused by new counters.
    const jump = 100;
    w.record(jump);
    // The new window is [jump-size+1, jump]. A counter from the OLD window must now read as TOO_OLD, not as a
    // stale "already seen" bit for whatever counter used to occupy that slot.
    expect(w.check(0)).toBe("TOO_OLD");
    // A fresh counter whose slot was previously used by an evicted counter must be ACCEPT, not REPLAY.
    expect(w.check(jump - size + 1)).toBe("ACCEPT");
  });

  it("advancing by exactly one slides the window by one without disturbing the rest", () => {
    const w = new AntiReplayWindow(64);
    for (let i = 0; i < 10; i++) w.record(i);
    w.record(10);
    for (let i = 0; i <= 10; i++) expect(w.check(i)).toBe("REPLAY");
  });

  it("constructor rejects a non-positive or non-multiple-of-8 size", () => {
    expect(() => new AntiReplayWindow(0)).toThrow(RangeError);
    expect(() => new AntiReplayWindow(-8)).toThrow(RangeError);
    expect(() => new AntiReplayWindow(10)).toThrow(RangeError);
  });

  it("record() is a no-op for correctness if called again on the same already-recorded counter (idempotent)", () => {
    const w = new AntiReplayWindow(64);
    w.record(3);
    w.record(3); // must not throw or corrupt state
    expect(w.check(3)).toBe("REPLAY");
    expect(w.check(4)).toBe("ACCEPT");
  });

  it("a long realistic run: random-ish jitter within the window never produces a false replay or false accept", () => {
    const size = 128;
    const w = new AntiReplayWindow(size);
    const seen = new Set<number>();
    // Deterministic pseudo-random jitter: each counter arrives at its true position +/- a few slots late.
    let s = 42;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const delayed: number[] = [];
    for (let i = 0; i < 1000; i++) {
      if (rand() < 0.1 && delayed.length > 0 && i - delayed[0]! < size - 1) {
        // Deliver a previously delayed counter now (out of order, still in window).
        const c = delayed.shift()!;
        const result = w.check(c);
        if (seen.has(c)) {
          expect(result).toBe("REPLAY");
        } else {
          expect(result).toBe("ACCEPT");
          w.record(c);
          seen.add(c);
        }
      }
      if (rand() < 0.15 && delayed.length < 3) {
        delayed.push(i); // hold this one back briefly instead of sending it now
        continue;
      }
      const result = w.check(i);
      expect(result).toBe("ACCEPT"); // i is always the new highest at this point, never seen before
      w.record(i);
      seen.add(i);
    }
  });
});
