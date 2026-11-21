import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
import { Resolver, type ResolverOptions } from "../src/resolver.js";
import { RCODE, TYPE, decodeMessage, encodeMessage, type Message, type ResourceRecord } from "../src/wire.js";
import { A, NS } from "./fakenet.js";
import {
  ALPHA1_IP,
  ALPHA2_IP,
  BIG_TXT,
  EXAMPLE_TLD_IP,
  FAKE_ROOT_HINTS,
  HOSTER_IP,
  LAME_IP,
  ROOT_IP,
  TEST_TLD_IP,
  buildNet,
} from "./fixtures.js";

const fake = buildNet();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

function resolver(opts: ResolverOptions = {}) {
  return new Resolver({ rootHints: FAKE_ROOT_HINTS, route: fake.route, timeoutMs: 1000, shuffle: false, ...opts });
}

const addrs = (rrs: ResourceRecord[]) => rrs.flatMap((r) => (r.data.kind === "A" || r.data.kind === "AAAA" ? [r.data.address] : [])).sort();
const names = (rrs: ResourceRecord[]) => rrs.map((r) => `${r.name} ${r.type}`);
const asked = (ip: string) => fake.get(ip).log.map((l) => `${l.name} ${l.type} ${l.transport}`);

describe("resolver: walking down from the root", () => {
  it("follows root -> test -> alpha.test referrals using glue, with RD=0 on every query", async () => {
    const r = await resolver().resolve("www.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(addrs(r.answers)).toEqual(["192.0.2.80", "192.0.2.81"]);
    expect(r.queries).toBe(3);
    expect(asked(ROOT_IP)).toEqual(["www.alpha.test 1 udp"]);
    expect(asked(TEST_TLD_IP)).toEqual(["www.alpha.test 1 udp"]);
    expect(asked(ALPHA1_IP)).toEqual(["www.alpha.test 1 udp"]);
    for (const s of fake.servers.values()) for (const l of s.log) expect(l.rd).toBe(false);
  });

  it("a second lookup is answered from the cache, and a sibling name starts at the cached zone cut", async () => {
    const res = resolver();
    await res.resolve("www.alpha.test", TYPE.A);
    fake.reset();
    const again = await res.resolve("www.alpha.test", TYPE.A);
    expect(again.queries).toBe(0);
    expect(addrs(again.answers)).toEqual(["192.0.2.80", "192.0.2.81"]);
    const sibling = await res.resolve("mail.alpha.test", TYPE.A);
    expect(addrs(sibling.answers)).toEqual(["192.0.2.25"]);
    expect(sibling.queries).toBe(1); // straight to alpha.test's server, no root, no TLD
    expect(asked(ROOT_IP)).toEqual([]);
  });

  it("names are case-insensitive", async () => {
    const r = await resolver().resolve("WWW.Alpha.TEST", TYPE.A);
    expect(addrs(r.answers)).toEqual(["192.0.2.80", "192.0.2.81"]);
  });

  it("resolves AAAA, MX, TXT and PTR", async () => {
    const res = resolver();
    expect(addrs((await res.resolve("www.alpha.test", TYPE.AAAA)).answers)).toEqual(["2001:db8::80"]);
    expect((await res.resolve("alpha.test", TYPE.MX)).answers[0]!.data).toEqual({ kind: "MX", preference: 10, exchange: "mail.alpha.test" });
    expect((await res.resolve("alpha.test", TYPE.TXT)).answers[0]!.data).toEqual({ kind: "TXT", texts: ["v=spf1 -all"] });
    expect((await res.resolve("ptr.alpha.test", TYPE.PTR)).answers[0]!.data).toEqual({ kind: "PTR", host: "www.alpha.test" });
  });

  it("out-of-bailiwick NS without glue: resolves ns.hoster.example first, then asks it for beta.test", async () => {
    const lines: string[] = [];
    const r = await resolver({ trace: (l) => lines.push(l) }).resolve("www.beta.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(addrs(r.answers)).toEqual(["203.0.113.80"]);
    expect(asked(EXAMPLE_TLD_IP)).toEqual(["ns.hoster.example 1 udp"]);
    expect(asked(HOSTER_IP)).toEqual(["ns.hoster.example 1 udp", "www.beta.test 1 udp"]);
    expect(lines.some((l) => l.includes("no glue: resolving NS host ns.hoster.example"))).toBe(true);
  });

  it("a delegation loop without glue (loop1.test <-> loop2.test) ends in SERVFAIL, within the budget", async () => {
    const r = await resolver({ maxQueries: 40 }).resolve("www.loop1.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.SERVFAIL);
    expect(r.queries).toBeLessThanOrEqual(40);
    expect(r.reason).toMatch(/deeper than|budget|no address/);
  });

  // The delegation-loop test above is stopped by EITHER limit, so removing one of them alone was not caught
  // (mutations R8 and R9). These two tests pin each limit separately.
  it("the query budget alone: maxQueries 2 cannot finish a 3-query lookup", async () => {
    const r = await resolver({ maxQueries: 2 }).resolve("www.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.SERVFAIL);
    expect(r.reason).toMatch(/budget of 2/);
    expect(r.queries).toBe(2);
  });

  it("the nesting limit alone: maxDepth 0 forbids the nested NS lookup that beta.test needs", async () => {
    const r = await resolver({ maxDepth: 0 }).resolve("www.beta.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.SERVFAIL);
    expect(r.reason).toMatch(/deeper than 0/);
  });
});

describe("resolver: CNAME, NXDOMAIN, NODATA", () => {
  it("a CNAME answered together with its target in one response", async () => {
    const r = await resolver().resolve("alias.alpha.test", TYPE.A);
    expect(names(r.answers)).toEqual(["alias.alpha.test 5", "www.alpha.test 1", "www.alpha.test 1"]);
    expect(asked(ALPHA1_IP)).toEqual(["alias.alpha.test 1 udp"]);
  });

  it("a CNAME into another zone is followed from the root of that zone", async () => {
    const r = await resolver().resolve("to-beta.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(names(r.answers)).toEqual(["to-beta.alpha.test 5", "www.beta.test 1"]);
    expect(addrs(r.answers)).toEqual(["203.0.113.80"]);
  });

  it("a CNAME chain longer than maxCnameChain is SERVFAIL; exactly the limit works", async () => {
    // c1 -> c2 -> ... -> c10 -> www: 10 links
    expect((await resolver({ maxCnameChain: 8 }).resolve("c1.alpha.test", TYPE.A)).rcode).toBe(RCODE.SERVFAIL);
    expect((await resolver({ maxCnameChain: 8 }).resolve("c3.alpha.test", TYPE.A)).rcode).toBe(RCODE.NOERROR); // 8 links
    expect((await resolver({ maxCnameChain: 10 }).resolve("c1.alpha.test", TYPE.A)).answers).toHaveLength(12);
  });

  it("a CNAME loop is SERVFAIL, not a hang", async () => {
    const r = await resolver().resolve("loopa.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.SERVFAIL);
    expect(r.reason).toMatch(/CNAME chain/);
  });

  it("NXDOMAIN comes back with the zone's SOA", async () => {
    const r = await resolver().resolve("nope.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NXDOMAIN);
    expect(r.answers).toEqual([]);
    expect(r.authority[0]!.type).toBe(TYPE.SOA);
    expect(r.authority[0]!.name).toBe("alpha.test");
  });

  it("NODATA: the name exists but not with this type (and an empty non-terminal is NODATA too)", async () => {
    const res = resolver();
    const r = await res.resolve("mail.alpha.test", TYPE.AAAA);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(r.answers).toEqual([]);
    expect(r.authority[0]!.type).toBe(TYPE.SOA);
    expect((await res.resolve("sub.alpha.test", TYPE.A)).rcode).toBe(RCODE.NOERROR);
  });

  it("a CNAME whose target does not exist: NXDOMAIN, with the CNAME in the answer", async () => {
    const r = await resolver().resolve("dangling.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NXDOMAIN);
    expect(names(r.answers)).toEqual(["dangling.alpha.test 5"]);
  });

  it("NXDOMAIN from the root for a TLD that does not exist", async () => {
    const r = await resolver().resolve("www.nosuchtld", TYPE.A);
    expect(r.rcode).toBe(RCODE.NXDOMAIN);
    expect(r.queries).toBe(1);
  });
});

describe("resolver: TCP fallback and failing servers", () => {
  it("a truncated (TC) UDP reply is retried over TCP to the same server", async () => {
    const r = await resolver().resolve("big.alpha.test", TYPE.TXT);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(r.answers[0]!.data).toEqual({ kind: "TXT", texts: BIG_TXT });
    expect(asked(ALPHA1_IP)).toEqual(["big.alpha.test 16 udp", "big.alpha.test 16 tcp"]);
  });

  it("a server that never answers times out and the next server of the zone is tried", async () => {
    fake.get(ALPHA1_IP).hook = () => "drop";
    const started = Date.now();
    const r = await resolver({ timeoutMs: 200 }).resolve("www.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(asked(ALPHA1_IP)).toHaveLength(1);
    expect(asked(ALPHA2_IP)).toEqual(["www.alpha.test 1 udp"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("SERVFAIL or REFUSED from one server: the next one is tried", async () => {
    for (const rcode of [RCODE.SERVFAIL, RCODE.REFUSED]) {
      fake.reset();
      fake.get(ALPHA1_IP).hook = ({ reply }) => ({ ...reply, header: { ...reply.header, rcode }, answers: [] });
      const r = await resolver().resolve("www.alpha.test", TYPE.A);
      expect(r.rcode).toBe(RCODE.NOERROR);
      expect(asked(ALPHA2_IP)).toHaveLength(1);
    }
  });

  it("every server of a zone dead: SERVFAIL after one try each, not a hang", async () => {
    fake.get(ALPHA1_IP).hook = () => "drop";
    fake.get(ALPHA2_IP).hook = () => "drop";
    const r = await resolver({ timeoutMs: 150 }).resolve("www.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.SERVFAIL);
    expect(r.reason).toMatch(/all servers for zone "alpha.test" failed/);
    expect(asked(ALPHA1_IP)).toHaveLength(1);
    expect(asked(ALPHA2_IP)).toHaveLength(1);
  });

  it("a lame server that refers us back UP (to the root) is skipped", async () => {
    fake.get(LAME_IP).hook = ({ reply }) => ({
      ...reply,
      header: { ...reply.header, aa: false },
      answers: [],
      authority: [NS("", "a.root-servers.test")],
      additional: [A("a.root-servers.test", ROOT_IP)],
    });
    const r = await resolver().resolve("www.lame.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.SERVFAIL);
    expect(r.reason).toMatch(/lame/);
  });

  it("a garbage reply from the right server is ignored and the query times out to the next server", async () => {
    const ignored: string[] = [];
    fake.get(ALPHA1_IP).hook = () => Buffer.from([1, 2, 3]);
    const r = await resolver({ timeoutMs: 200, onIgnored: (why, ip) => ignored.push(`${why} ${ip}`) }).resolve("www.alpha.test", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(ignored).toEqual([`undecodable ${ALPHA1_IP}`]);
  });
});

describe("resolver: spoofing and cache-poisoning defences", () => {
  it("a reply with the wrong ID is ignored, the real one is used", async () => {
    const ignored: string[] = [];
    fake.get(ALPHA1_IP).hook = ({ reply, send }) => {
      const forged: Message = {
        ...reply,
        header: { ...reply.header, id: (reply.header.id + 1) & 0xffff },
        answers: [A("www.alpha.test", "203.0.113.66")],
      };
      send(encodeMessage(forged));
      return undefined; // then the genuine reply
    };
    const r = await resolver({ onIgnored: (why) => ignored.push(why) }).resolve("www.alpha.test", TYPE.A);
    expect(addrs(r.answers)).toEqual(["192.0.2.80", "192.0.2.81"]);
    expect(ignored).toEqual(["mismatch"]);
  });

  it("a reply from a different source port (off-path spoofer with the right ID) is ignored", async () => {
    const ignored: string[] = [];
    fake.get(ALPHA1_IP).hook = async ({ reply, spoof }) => {
      await spoof(encodeMessage({ ...reply, answers: [A("www.alpha.test", "203.0.113.66")] }));
      return undefined;
    };
    const r = await resolver({ onIgnored: (why) => ignored.push(why) }).resolve("www.alpha.test", TYPE.A);
    expect(addrs(r.answers)).toEqual(["192.0.2.80", "192.0.2.81"]);
    expect(ignored).toEqual(["wrong-source"]);
  });

  it("a reply that echoes a different question is ignored", async () => {
    const ignored: string[] = [];
    fake.get(ALPHA1_IP).hook = ({ reply, send }) => {
      send(encodeMessage({ ...reply, questions: [{ ...reply.questions[0]!, name: "evil.alpha.test" }] }));
      return undefined;
    };
    await resolver({ onIgnored: (why) => ignored.push(why) }).resolve("www.alpha.test", TYPE.A);
    expect(ignored).toEqual(["mismatch"]);
  });

  it("query IDs and source ports are random", async () => {
    const res = resolver();
    for (let i = 0; i < 20; i++) await res.resolve(`n${i}.alpha.test`, TYPE.A);
    const log = fake.get(ALPHA1_IP).log;
    expect(log.length).toBeGreaterThanOrEqual(20);
    expect(new Set(log.map((l) => l.id)).size).toBeGreaterThanOrEqual(18);
    expect(new Set(log.map((l) => l.port)).size).toBeGreaterThanOrEqual(18);
    expect(log.every((l) => l.port >= 10000)).toBe(true);
  });

  it("bailiwick: extra answer and additional records for ANOTHER zone are not cached", async () => {
    const cache = new Cache();
    fake.get(ALPHA1_IP).hook = ({ query, reply }) =>
      query.questions[0]!.name === "www.alpha.test"
        ? {
            ...reply,
            answers: [...reply.answers, A("www.beta.test", "203.0.113.66"), A("ns.hoster.example", "203.0.113.67")],
            authority: [NS("beta.test", "ns.evil.alpha.test")],
            additional: [A("ns.evil.alpha.test", "203.0.113.68")],
          }
        : undefined;
    const lines: string[] = [];
    const res = resolver({ cache, trace: (l) => lines.push(l) });
    await res.resolve("www.alpha.test", TYPE.A);
    expect(cache.getRRset("www.beta.test", TYPE.A, "referral")).toBeUndefined();
    expect(cache.getRRset("ns.hoster.example", TYPE.A, "referral")).toBeUndefined();
    expect(cache.getRRset("beta.test", TYPE.NS, "referral")).toBeUndefined();
    expect(lines.some((l) => l.includes("dropped 3 out-of-bailiwick"))).toBe(true);
    const beta = await res.resolve("www.beta.test", TYPE.A);
    expect(addrs(beta.answers)).toEqual(["203.0.113.80"]);
  });

  it("bailiwick: out-of-zone glue in a referral is not used; the NS name is resolved properly", async () => {
    const cache = new Cache();
    fake.get(TEST_TLD_IP).hook = ({ query, reply }) =>
      query.questions[0]!.name === "www.beta.test" ? { ...reply, additional: [A("ns.hoster.example", "192.0.2.66")] } : undefined;
    const r = await resolver({ cache }).resolve("www.beta.test", TYPE.A);
    expect(addrs(r.answers)).toEqual(["203.0.113.80"]);
    expect(addrs(cache.getRRset("ns.hoster.example", TYPE.A, "referral") ?? [])).toEqual([HOSTER_IP]);
  });

  it("referral data (NS and glue) is cached at low rank: never returned as an answer", async () => {
    const cache = new Cache();
    await resolver({ cache }).resolve("www.alpha.test", TYPE.A);
    expect(cache.getRRset("ns1.alpha.test", TYPE.A, "referral")).toBeDefined();
    expect(cache.getRRset("ns1.alpha.test", TYPE.A, "answer")).toBeUndefined();
    fake.reset();
    const r = await resolver({ cache }).resolve("ns1.alpha.test", TYPE.A);
    expect(addrs(r.answers)).toEqual([ALPHA1_IP]);
    expect(asked(ALPHA1_IP)).toEqual(["ns1.alpha.test 1 udp"]); // asked the authority, not served from glue
  });

  it("the decoded query the fake server saw is a plain question (sanity check of our own encoder)", async () => {
    let seen: Message | undefined;
    fake.get(ROOT_IP).hook = ({ query }) => {
      seen = decodeMessage(encodeMessage(query));
      return undefined;
    };
    await resolver().resolve("www.alpha.test", TYPE.A);
    expect(seen?.questions).toEqual([{ name: "www.alpha.test", type: TYPE.A, class: 1 }]);
    expect(seen?.answers).toEqual([]);
  });
});
