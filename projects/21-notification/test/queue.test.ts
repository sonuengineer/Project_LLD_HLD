import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../src/queue.js";

const job = (recordId: string, priority: number, runAt: number) => ({ recordId, channel: "push" as const, priority, runAt });

describe("InMemoryJobQueue", () => {
  it("claims ready jobs by priority, then runAt, then FIFO; delayed jobs wait", () => {
    const q = new InMemoryJobQueue();
    q.enqueue(job("m1", 1, 0));
    q.enqueue(job("m2", 1, 0));
    q.enqueue(job("t-late", 0, 50));
    q.enqueue(job("t1", 0, 10));
    q.enqueue(job("future", 0, 1000));
    expect(q.claim(100, 10, 10_000).map((j) => j.recordId)).toEqual(["t1", "t-late", "m1", "m2"]);
    expect(q.claim(100, 10, 10_000)).toEqual([]); // all leased, "future" not due
    expect(q.claim(1000, 10, 10_000).map((j) => j.recordId)).toEqual(["future"]);
  });

  it("claim respects max", () => {
    const q = new InMemoryJobQueue();
    for (let i = 0; i < 5; i++) q.enqueue(job(`r${i}`, 1, 0));
    expect(q.claim(0, 2, 60)).toHaveLength(2);
    expect(q.claim(0, 10, 60)).toHaveLength(3);
  });

  it("only the current lease holder may complete or reschedule; an expired lease is lost", () => {
    const q = new InMemoryJobQueue();
    const id = q.enqueue(job("r", 0, 0));
    const [a] = q.claim(0, 1, 100);
    expect(q.owns(id, a!.leaseToken, 99)).toBe(true);
    expect(q.owns(id, a!.leaseToken, 100)).toBe(false); // the lease ends AT leaseUntil
    const [b] = q.claim(100, 1, 100); // visible again: another worker takes it
    expect(b!.claims).toBe(2);
    expect(q.complete(id, a!.leaseToken, 101)).toBe(false); // the old worker is refused
    expect(q.reschedule(id, a!.leaseToken, 500, 101)).toBe(false);
    expect(q.size).toBe(1);
    expect(q.complete(id, b!.leaseToken, 150)).toBe(true);
    expect(q.size).toBe(0);
    expect(q.stats).toMatchObject({ claimed: 2, reclaimed: 1, completed: 1, refused: 2 });
  });

  it("reschedule releases the lease and sets the new time", () => {
    const q = new InMemoryJobQueue();
    const id = q.enqueue(job("r", 0, 0));
    const [a] = q.claim(0, 1, 100);
    expect(q.reschedule(id, a!.leaseToken, 300, 10)).toBe(true);
    expect(q.claim(299, 1, 100)).toEqual([]);
    expect(q.claim(300, 1, 100)).toHaveLength(1);
    expect(q.jobs()[0]).toMatchObject({ runAt: 300, claims: 2, leaseUntil: 400 });
  });

  it("rejects bad claim arguments", () => {
    const q = new InMemoryJobQueue();
    expect(() => q.claim(0, 0, 10)).toThrow(RangeError);
    expect(() => q.claim(0, 1, 0)).toThrow(RangeError);
  });
});
