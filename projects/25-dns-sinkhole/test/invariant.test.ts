/**
 * Randomized invariant test: a long random sequence of queries (mixing blocked and allowed domains, with the
 * clock jumping forward by random amounts) is checked against a hand-tracked shadow model of what the blocklist
 * and cache SHOULD imply -- not against a second implementation, since there is nothing else to compare against
 * here. The invariant: a blocked query is never forwarded; an allowed query hits upstream exactly when the
 * shadow model says its cache entry is missing or expired, and the answer it gets back is consistent with that.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BlockList } from "../src/blocklist.js";
import { ResponseCache } from "../src/cache.js";
import { ManualClock } from "../src/clock.js";
import { SinkholeProxy } from "../src/proxy.js";
import { StubUpstream } from "../src/stub-upstream.js";
import { RCODE, TYPE, buildQuery, decodeResponse } from "../src/wire.js";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let stub: StubUpstream | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

const BLOCKED_DOMAINS = ["ads.example.com", "tracker.net"];
const DOMAIN_POOL = [
  "ads.example.com", // exact blocked
  "x.ads.example.com", // subdomain of blocked
  "deep.x.ads.example.com",
  "tracker.net", // exact blocked
  "a.tracker.net",
  "news.example.com", // allowed
  "shop.example.com",
  "cdn.test",
  "api.cdn.test",
];
const TTL_BY_DOMAIN = new Map(DOMAIN_POOL.map((d, i) => [d, 20 + i * 7])); // varied TTLs

describe("randomized invariant: blocklist + cache state always matches what the proxy answers", () => {
  it.each([1, 2, 3, 4, 5])("seed %i", async (seed) => {
    const rand = mulberry32(seed);
    const clock = new ManualClock(0);
    stub = new StubUpstream({
      behavior: (name) => ({ kind: "answer", ttl: TTL_BY_DOMAIN.get(name) ?? 30, address: "203.0.113.5" }),
    });
    const upstream = await stub.listen();
    const proxy = new SinkholeProxy({
      blockList: new BlockList(BLOCKED_DOMAINS),
      mode: "nxdomain",
      upstream,
      udpTimeoutMs: 500,
      tcpTimeoutMs: 500,
      cache: new ResponseCache({ clock }),
    });

    const blocked = (name: string) => BLOCKED_DOMAINS.some((b) => name === b || name.endsWith(`.${b}`));
    const nextExpiryMs = new Map<string, number>(); // shadow model: when each name's cache entry expires

    let expectedUpstreamCalls = 0;

    for (let i = 0; i < 400; i++) {
      // occasionally move the clock forward, sometimes enough to expire entries, sometimes not
      if (rand() < 0.4) clock.advance(Math.floor(rand() * 15_000));

      const name = DOMAIN_POOL[Math.floor(rand() * DOMAIN_POOL.length)]!;
      const id = Math.floor(rand() * 0x10000);
      const reply = decodeResponse((await proxy.handle(buildQuery(id, name, TYPE.A)))!);

      expect(reply.header.id).toBe(id); // always echoes the exact id asked, blocked or not

      if (blocked(name)) {
        expect(reply.header.rcode).toBe(RCODE.NXDOMAIN);
        continue; // a blocked query never touches the shadow cache model or upstream
      }

      const expiry = nextExpiryMs.get(name);
      const isFresh = expiry !== undefined && expiry > clock.now();
      if (!isFresh) expectedUpstreamCalls++; // model says: this one must go to upstream

      expect(reply.header.rcode).toBe(RCODE.NOERROR);
      expect(stub.callCount).toBe(expectedUpstreamCalls);

      if (!isFresh) nextExpiryMs.set(name, clock.now() + (TTL_BY_DOMAIN.get(name) ?? 30) * 1000);
    }
  });
});
