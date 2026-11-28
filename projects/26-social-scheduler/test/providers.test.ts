import { describe, expect, it } from "vitest";
import { AlwaysFailsProvider, AlwaysSucceedsProvider, FlakyProvider } from "../src/providers.js";

const msg = (postId: string, channel: string, attempt: number) => ({ postId, channel, content: "hi", attempt });

describe("AlwaysSucceedsProvider", () => {
  it("always sends and records attempts/sent", async () => {
    const provider = new AlwaysSucceedsProvider();
    const r1 = await provider.send(msg("p1", "alpha", 1));
    const r2 = await provider.send(msg("p1", "alpha", 2));
    expect(r1.status).toBe("sent");
    expect(r2.status).toBe("sent");
    expect(provider.attempts).toHaveLength(2);
    expect(provider.sent).toHaveLength(2);
  });
});

describe("AlwaysFailsProvider", () => {
  it("always fails with the configured reason", async () => {
    const provider = new AlwaysFailsProvider("nope");
    const r = await provider.send(msg("p1", "gamma", 1));
    expect(r).toEqual({ status: "failed", reason: "nope" });
    expect(provider.attempts).toHaveLength(1);
  });

  it("defaults to a generic reason", async () => {
    const provider = new AlwaysFailsProvider();
    const r = await provider.send(msg("p1", "gamma", 1));
    expect(r.status).toBe("failed");
  });
});

describe("FlakyProvider", () => {
  it("fails the first K attempts then succeeds, per (postId, channel)", async () => {
    const provider = new FlakyProvider(2);
    expect((await provider.send(msg("p1", "beta", 1))).status).toBe("failed");
    expect((await provider.send(msg("p1", "beta", 2))).status).toBe("failed");
    expect((await provider.send(msg("p1", "beta", 3))).status).toBe("sent");
    expect((await provider.send(msg("p1", "beta", 4))).status).toBe("sent"); // stays succeeding after
  });

  it("tracks each (postId, channel) key independently", async () => {
    const provider = new FlakyProvider(1);
    expect((await provider.send(msg("p1", "beta", 1))).status).toBe("failed");
    // a different post on the same channel starts its own count from zero
    expect((await provider.send(msg("p2", "beta", 1))).status).toBe("failed");
    expect((await provider.send(msg("p1", "beta", 2))).status).toBe("sent");
    expect((await provider.send(msg("p2", "beta", 2))).status).toBe("sent");
  });

  it("failCount of 0 always succeeds", async () => {
    const provider = new FlakyProvider(0);
    expect((await provider.send(msg("p1", "beta", 1))).status).toBe("sent");
  });

  it("rejects a negative or non-integer failCount", () => {
    expect(() => new FlakyProvider(-1)).toThrow(RangeError);
    expect(() => new FlakyProvider(1.5)).toThrow(RangeError);
  });
});
