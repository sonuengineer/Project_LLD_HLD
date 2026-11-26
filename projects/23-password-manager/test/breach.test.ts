import { describe, expect, it } from "vitest";
import { FakeBreachProvider, isPasswordBreached, sha1Hex } from "../src/breach.js";

const ALWAYS_ABORTED_SIGNAL = (() => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
})();

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("sha1Hex", () => {
  it("matches the well-known public SHA-1 of a classic test string", () => {
    // A widely published, easily independently verifiable value -- not invented for this test.
    expect(sha1Hex("password")).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
  });

  it("is deterministic and case-insensitive-looking output is always uppercase", () => {
    expect(sha1Hex("hunter2")).toBe(sha1Hex("hunter2"));
    expect(sha1Hex("hunter2")).toBe(sha1Hex("hunter2").toUpperCase());
  });
});

describe("FakeBreachProvider", () => {
  it("returns the matching suffix for a known breached password's prefix, and nothing for an unrelated prefix", async () => {
    const provider = new FakeBreachProvider(["password"]);
    const hash = sha1Hex("password");
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    expect(await provider.lookupPrefix(prefix, liveSignal())).toContain(suffix);
    expect(await provider.lookupPrefix("00000", liveSignal())).toEqual([]);
  });

  it("an aborted signal throws instead of returning a result", async () => {
    const provider = new FakeBreachProvider(["password"]);
    await expect(provider.lookupPrefix("5BAA6", ALWAYS_ABORTED_SIGNAL)).rejects.toThrow();
  });
});

describe("isPasswordBreached", () => {
  it("is true for a password in the provider's dataset, false for one that is not", async () => {
    const provider = new FakeBreachProvider(["password123"]);
    expect(await isPasswordBreached("password123", provider, liveSignal())).toBe(true);
    expect(await isPasswordBreached("a-totally-different-and-strong-password", provider, liveSignal())).toBe(false);
  });

  it("never sends more than a 5-character prefix to the provider -- never the full hash, never the password", async () => {
    const seen: string[] = [];
    const spyProvider = {
      async lookupPrefix(prefix: string) {
        seen.push(prefix);
        return [];
      },
    };
    const password = "correct-horse-battery-staple";
    await isPasswordBreached(password, spyProvider, liveSignal());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(5);
    expect(seen[0]).not.toContain(password);
    expect(seen[0]).not.toBe(sha1Hex(password));
    expect(sha1Hex(password).startsWith(seen[0]!)).toBe(true);
  });
});
