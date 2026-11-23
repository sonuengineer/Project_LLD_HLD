import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientIp, ipKey, keyByIp, rateLimitHeaders } from "../src/adapters/http.js";

const req = (remoteAddress: string | undefined, xff?: string | string[]) =>
  ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;

describe("clientIp", () => {
  it("default (no trusted proxy): the socket address; a forged X-Forwarded-For is IGNORED", () => {
    expect(clientIp(req("10.0.0.5", "1.2.3.4"))).toBe("10.0.0.5");
  });

  it("1 trusted proxy: the right-most X-Forwarded-For entry (what our proxy saw), not what the client wrote", () => {
    // client sent "6.6.6.6" itself; our nginx appended the real address 203.0.113.9
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });

  it("2 trusted proxies: the second from the right", () => {
    expect(clientIp(req("10.0.0.3", "6.6.6.6, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
  });

  it("repeated X-Forwarded-For headers are joined in order", () => {
    expect(clientIp(req("10.0.0.2", ["6.6.6.6", "203.0.113.9"]), 1)).toBe("203.0.113.9");
  });

  it("fewer entries than trusted proxies: the left-most available (like Express trust proxy = n)", () => {
    expect(clientIp(req("10.0.0.2", "203.0.113.9"), 5)).toBe("203.0.113.9");
    expect(clientIp(req("10.0.0.2"), 3)).toBe("10.0.0.2");
  });

  it("rejects a negative or fractional proxy count", () => {
    expect(() => clientIp(req("1.1.1.1"), -1)).toThrow(RangeError);
    expect(() => clientIp(req("1.1.1.1"), 1.5)).toThrow(RangeError);
  });
});

describe("ipKey", () => {
  it.each([
    ["203.0.113.9", "ip:203.0.113.9"],
    ["::ffff:203.0.113.9", "ip:203.0.113.9"], // IPv4-mapped: the same client as plain IPv4
    ["::FFFF:203.0.113.9", "ip:203.0.113.9"],
    ["2001:db8:1:2:3:4:5:6", "ip6:2001:db8:1:2::/64"],
    ["2001:db8:1:2::99", "ip6:2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff::1", "ip6:2001:db8:1:2::/64"], // leading zeros normalised
    ["2001:db8::1", "ip6:2001:db8:0:0::/64"],
    ["::1", "ip6:0:0:0:0::/64"],
    ["fe80::1%eth0", "ip6:fe80:0:0:0::/64"],
  ])("%s -> %s", (addr, key) => {
    expect(ipKey(addr)).toBe(key);
  });

  it("every address in one /64 is ONE client (no fresh limit per address)", () => {
    const keys = new Set(["2001:db8:aa:bb::1", "2001:db8:aa:bb:ffff:ffff:ffff:ffff", "2001:db8:aa:bb:1234::"].map(ipKey));
    expect(keys.size).toBe(1);
    expect(ipKey("2001:db8:aa:bc::1")).not.toBe(ipKey("2001:db8:aa:bb::1"));
  });

  it.each([undefined, "", "not-an-ip", "999.1.1.1", "1.2.3"])("%j -> undefined (not limited by IP)", (addr) => {
    expect(ipKey(addr)).toBeUndefined();
  });

  it("keyByIp combines both", async () => {
    expect(await keyByIp()(req("::ffff:1.2.3.4", "9.9.9.9"))).toBe("ip:1.2.3.4");
    expect(await keyByIp({ trustedProxies: 1 })(req("10.0.0.2", "9.9.9.9"))).toBe("ip:9.9.9.9");
  });
});

describe("rateLimitHeaders", () => {
  it("allowed: limit, remaining, reset in whole seconds (rounded up); no Retry-After", () => {
    expect(rateLimitHeaders({ allowed: true, limit: 10, remaining: 7, retryAfterMs: 0, resetMs: 1500 })).toEqual({
      "ratelimit-limit": "10",
      "ratelimit-remaining": "7",
      "ratelimit-reset": "2",
    });
  });

  it("denied: Retry-After rounded up, at least 1", () => {
    expect(rateLimitHeaders({ allowed: false, limit: 5, remaining: 0, retryAfterMs: 2001, resetMs: 5000 })["retry-after"]).toBe("3");
    expect(rateLimitHeaders({ allowed: false, limit: 5, remaining: 0, retryAfterMs: 1, resetMs: 1 })["retry-after"]).toBe("1");
    expect(rateLimitHeaders({ allowed: false, limit: 5, remaining: 0, retryAfterMs: 0, resetMs: 0 })["retry-after"]).toBe("1");
  });
});
