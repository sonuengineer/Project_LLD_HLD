import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
import { Resolver } from "../src/resolver.js";
import { RCODE, TYPE } from "../src/wire.js";
import { A, SOA } from "./fakenet.js";
import { ALPHA1_IP, FAKE_ROOT_HINTS, ROOT_IP, buildNet } from "./fixtures.js";

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (sec: number) => (t += sec * 1000) };
}

describe("cache: unit", () => {
  it("an RRset lives for its smallest TTL, and reads count the TTL down", () => {
    const c = clock();
    const cache = new Cache({ now: c.now });
    cache.putRRset([A("w.test", "192.0.2.1", 300), A("w.test", "192.0.2.2", 100)], "answer");
    expect(cache.getRRset("w.test", TYPE.A)!.map((r) => r.ttl)).toEqual([100, 100]);
    c.advance(40);
    expect(cache.getRRset("w.test", TYPE.A)!.map((r) => r.ttl)).toEqual([60, 60]);
    c.advance(59);
    expect(cache.getRRset("w.test", TYPE.A)).toHaveLength(2);
    c.advance(1);
    expect(cache.getRRset("w.test", TYPE.A)).toBeUndefined();
    expect(cache.size).toBe(0); // the expired entry is removed on read
  });

  it("TTL 0 is never cached; a huge TTL is capped at maxTtl", () => {
    const c = clock();
    const cache = new Cache({ now: c.now, maxTtl: 3600 });
    expect(cache.putRRset([A("z.test", "192.0.2.1", 0)], "answer")).toBe(false);
    cache.putRRset([A("h.test", "192.0.2.1", 2_000_000_000)], "answer");
    expect(cache.getRRset("h.test", TYPE.A)![0]!.ttl).toBe(3600);
    c.advance(3600);
    expect(cache.getRRset("h.test", TYPE.A)).toBeUndefined();
  });

  it("lookups are case-insensitive", () => {
    const cache = new Cache();
    cache.putRRset([A("WWW.Test", "192.0.2.1")], "answer");
    expect(cache.getRRset("www.TEST", TYPE.A)).toHaveLength(1);
  });

  it("referral data does not overwrite an unexpired answer, and is not returned as an answer", () => {
    const c = clock();
    const cache = new Cache({ now: c.now });
    cache.putRRset([A("ns.test", "192.0.2.1", 100)], "answer");
    expect(cache.putRRset([A("ns.test", "203.0.113.9", 100)], "referral")).toBe(false);
    expect(cache.getRRset("ns.test", TYPE.A)![0]!.data).toEqual({ kind: "A", address: "192.0.2.1" });
    c.advance(100);
    expect(cache.putRRset([A("ns.test", "203.0.113.9", 100)], "referral")).toBe(true); // the answer had expired
    expect(cache.getRRset("ns.test", TYPE.A, "answer")).toBeUndefined();
    expect(cache.getRRset("ns.test", TYPE.A, "referral")).toHaveLength(1);
    // and an answer DOES replace referral data
    expect(cache.putRRset([A("ns.test", "192.0.2.7", 100)], "answer")).toBe(true);
    expect(cache.getRRset("ns.test", TYPE.A, "answer")![0]!.data).toEqual({ kind: "A", address: "192.0.2.7" });
  });

  it("negative TTL = min(SOA TTL, SOA minimum); NXDOMAIN covers every type, NODATA only one", () => {
    const c = clock();
    const cache = new Cache({ now: c.now });
    expect(cache.putNegative("gone.test", TYPE.A, "NXDOMAIN", SOA("test", 60, 3600))).toBe(60);
    expect(cache.putNegative("x.test", TYPE.AAAA, "NODATA", SOA("test", 900, 30))).toBe(30);
    expect(cache.getNegative("gone.test", TYPE.MX)?.kind).toBe("NXDOMAIN");
    expect(cache.getNegative("x.test", TYPE.AAAA)?.kind).toBe("NODATA");
    expect(cache.getNegative("x.test", TYPE.A)).toBeUndefined();
    c.advance(30);
    expect(cache.getNegative("x.test", TYPE.AAAA)).toBeUndefined();
    expect(cache.getNegative("gone.test", TYPE.A)!.soa.ttl).toBe(30);
    c.advance(30);
    expect(cache.getNegative("gone.test", TYPE.A)).toBeUndefined();
  });

  it("a negative answer without an SOA is not cached; negative TTL is capped at maxNegativeTtl", () => {
    const cache = new Cache({ maxNegativeTtl: 100 });
    expect(cache.putNegative("a.test", TYPE.A, "NXDOMAIN", undefined)).toBe(0);
    expect(cache.putNegative("b.test", TYPE.A, "NXDOMAIN", SOA("test", 86400, 86400))).toBe(100);
  });

  it("learning a record for a name clears an old negative entry for it", () => {
    const cache = new Cache();
    cache.putNegative("n.test", TYPE.A, "NXDOMAIN", SOA("test"));
    cache.putRRset([A("n.test", "192.0.2.1")], "answer");
    expect(cache.getNegative("n.test", TYPE.A)).toBeUndefined();
  });

  it("when full, the oldest entry is evicted", () => {
    const cache = new Cache({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) cache.putRRset([A(`h${i}.test`, "192.0.2.1")], "answer");
    expect(cache.size).toBe(3);
    expect(cache.getRRset("h0.test", TYPE.A)).toBeUndefined();
    expect(cache.getRRset("h4.test", TYPE.A)).toHaveLength(1);
  });

  it("returned records are copies: changing them does not change the cache", () => {
    const cache = new Cache();
    cache.putRRset([A("c.test", "192.0.2.1")], "answer");
    const got = cache.getRRset("c.test", TYPE.A)!;
    (got[0]!.data as { address: string }).address = "203.0.113.1";
    expect(cache.getRRset("c.test", TYPE.A)![0]!.data).toEqual({ kind: "A", address: "192.0.2.1" });
  });
});

describe("cache: with the resolver", () => {
  const fake = buildNet();
  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  beforeEach(() => fake.reset());

  const make = (c: ReturnType<typeof clock>) => {
    const cache = new Cache({ now: c.now });
    return new Resolver({ rootHints: FAKE_ROOT_HINTS, route: fake.route, timeoutMs: 1000, shuffle: false, cache });
  };

  it("an answer is re-fetched after its TTL (300 s), but the zone cut (86400 s) is still used", async () => {
    const c = clock();
    const res = make(c);
    await res.resolve("www.alpha.test", TYPE.A);
    c.advance(299);
    expect((await res.resolve("www.alpha.test", TYPE.A)).queries).toBe(0);
    c.advance(1);
    fake.reset();
    const r = await res.resolve("www.alpha.test", TYPE.A);
    expect(r.queries).toBe(1);
    expect(fake.get(ALPHA1_IP).log).toHaveLength(1);
    expect(fake.get(ROOT_IP).log).toHaveLength(0);
  });

  it("NXDOMAIN is cached for the SOA minimum (60 s) and covers other types of the same name", async () => {
    const c = clock();
    const res = make(c);
    expect((await res.resolve("nope.alpha.test", TYPE.A)).rcode).toBe(RCODE.NXDOMAIN);
    fake.reset();
    const again = await res.resolve("nope.alpha.test", TYPE.MX);
    expect(again.rcode).toBe(RCODE.NXDOMAIN);
    expect(again.queries).toBe(0);
    expect(again.authority[0]!.type).toBe(TYPE.SOA);
    c.advance(60);
    expect((await res.resolve("nope.alpha.test", TYPE.A)).queries).toBe(1);
  });

  it("NODATA is cached per type: another type of the same name is still asked", async () => {
    const c = clock();
    const res = make(c);
    expect((await res.resolve("mail.alpha.test", TYPE.AAAA)).answers).toEqual([]);
    fake.reset();
    expect((await res.resolve("mail.alpha.test", TYPE.AAAA)).queries).toBe(0);
    expect((await res.resolve("mail.alpha.test", TYPE.A)).queries).toBe(1);
  });

  it("a cached CNAME is followed without asking again", async () => {
    const c = clock();
    const res = make(c);
    await res.resolve("alias.alpha.test", TYPE.A);
    fake.reset();
    const r = await res.resolve("alias.alpha.test", TYPE.A);
    expect(r.queries).toBe(0);
    expect(r.answers.map((a) => a.type)).toEqual([TYPE.CNAME, TYPE.A, TYPE.A]);
  });
});
