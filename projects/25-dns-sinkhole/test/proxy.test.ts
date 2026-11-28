import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BlockList, loadBlockListFile } from "../src/blocklist.js";
import { ResponseCache } from "../src/cache.js";
import { ManualClock } from "../src/clock.js";
import { SinkholeProxy } from "../src/proxy.js";
import { StubUpstream, type StubBehavior } from "../src/stub-upstream.js";
import { CLASS_IN, RCODE, TYPE, buildQuery, decodeResponse, emptyHeader, encodeMessage } from "../src/wire.js";

let stub: StubUpstream | undefined;

afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

/** Starts a stub upstream with the given behavior and a proxy pointed at it, with a ManualClock-backed cache. */
async function harness(
  behavior: (name: string, type: number) => StubBehavior,
  opts: {
    blocked?: string[];
    allowed?: string[];
    mode?: "nxdomain" | "sinkhole";
    clock?: ManualClock;
    sinkholeAddress?: string;
    udpTimeoutMs?: number;
    tcpTimeoutMs?: number;
  } = {},
) {
  stub = new StubUpstream({ behavior });
  const upstream = await stub.listen();
  const clock = opts.clock ?? new ManualClock(0);
  const proxy = new SinkholeProxy({
    blockList: new BlockList(opts.blocked ?? []),
    allowList: opts.allowed ? new BlockList(opts.allowed) : undefined,
    mode: opts.mode ?? "nxdomain",
    sinkholeAddress: opts.sinkholeAddress,
    upstream,
    udpTimeoutMs: opts.udpTimeoutMs ?? 300,
    tcpTimeoutMs: opts.tcpTimeoutMs ?? 300,
    cache: new ResponseCache({ clock }),
  });
  return { proxy, stub, clock };
}

const answer: StubBehavior = { kind: "answer", ttl: 300, address: "203.0.113.5" };

describe("blocking", () => {
  it("an exact blocked domain never reaches upstream", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NXDOMAIN);
    expect(stub.callCount).toBe(0);
  });

  it("a subdomain of a blocked domain is blocked too", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "x.ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NXDOMAIN);
    expect(stub.callCount).toBe(0);
  });

  it("a non-blocked domain is allowed through and forwarded upstream", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "news.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1);
  });

  it("the forwarded answer is relayed back with the client's exact transaction id", async () => {
    const { proxy } = await harness(() => answer);
    const reply = decodeResponse((await proxy.handle(buildQuery(0xbeef, "news.example.com", TYPE.A)))!);
    expect(reply.header.id).toBe(0xbeef);
    expect(reply.header.qr).toBe(true);
  });
});

describe("block modes", () => {
  it("nxdomain mode: NXDOMAIN, no answer", async () => {
    const { proxy } = await harness(() => answer, { blocked: ["ads.test"], mode: "nxdomain" });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "ads.test", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NXDOMAIN);
    expect(reply.answers).toEqual([]);
  });

  it("sinkhole mode: NOERROR with the configured A record, for an A query", async () => {
    const { proxy } = await harness(() => answer, { blocked: ["ads.test"], mode: "sinkhole", sinkholeAddress: "0.0.0.0" });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "ads.test", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
    expect(reply.answers).toMatchObject([{ name: "ads.test", type: TYPE.A, class: CLASS_IN, ttl: 60 }]);
  });

  it("sinkhole mode uses the configured address, not a hardcoded one", async () => {
    const { proxy } = await harness(() => answer, { blocked: ["ads.test"], mode: "sinkhole", sinkholeAddress: "10.10.10.10" });
    const raw = (await proxy.handle(buildQuery(1, "ads.test", TYPE.A)))!;
    expect(raw.subarray(raw.length - 4)).toEqual(Buffer.from([10, 10, 10, 10]));
  });

  it("sinkhole mode still answers NXDOMAIN for a non-A query type (AAAA sinkholing is out of scope)", async () => {
    const { proxy } = await harness(() => answer, { blocked: ["ads.test"], mode: "sinkhole" });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "ads.test", TYPE.AAAA)))!);
    expect(reply.header.rcode).toBe(RCODE.NXDOMAIN);
  });
});

describe("allowlist (Stage 2)", () => {
  it("a domain on the allowlist is forwarded even though it is ALSO exactly on the blocklist", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.test"], allowed: ["ads.test"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "ads.test", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1);
  });

  it("a domain whose PARENT is blocklisted but the domain itself is allowlisted is forwarded (specific override)", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"], allowed: ["safe.ads.example.com"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "safe.ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1);
  });

  it("a sibling subdomain NOT on the allowlist, under the same blocklisted parent, is still blocked", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"], allowed: ["safe.ads.example.com"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "other.ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NXDOMAIN);
    expect(stub.callCount).toBe(0); // the override did not accidentally un-block the whole parent subtree
  });

  it("a broader ALLOWED parent beats a narrower BLOCKED subdomain too -- allowlist wins unconditionally, not by specificity", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"], allowed: ["example.com"] });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1);
  });

  it("a domain on neither list behaves exactly as Stage 1 did (regression)", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"], allowed: ["safe.ads.example.com"] });
    const blocked = decodeResponse((await proxy.handle(buildQuery(1, "tracker.ads.example.com", TYPE.A)))!);
    expect(blocked.header.rcode).toBe(RCODE.NXDOMAIN);
    const forwarded = decodeResponse((await proxy.handle(buildQuery(2, "news.example.com", TYPE.A)))!);
    expect(forwarded.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1); // only the non-blocked, non-allowlist-related query reached upstream
  });

  it("loading a real allowlist file end to end", async () => {
    const domains = loadBlockListFile(fileURLToPath(new URL("../config/allowlist.txt", import.meta.url)));
    expect(domains).toContain("allowed.ads.example.com");
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"], allowed: domains });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "allowed.ads.example.com", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1);
  });

  it("stats.allowed counts allowlist-overridden queries, distinct from forwarded/cacheHits", async () => {
    const { proxy } = await harness(() => answer, { blocked: ["ads.example.com"], allowed: ["safe.ads.example.com"] });
    await proxy.handle(buildQuery(1, "safe.ads.example.com", TYPE.A)); // allowed + forwarded (cache miss)
    await proxy.handle(buildQuery(2, "safe.ads.example.com", TYPE.A)); // allowed + cache hit
    await proxy.handle(buildQuery(3, "tracker.ads.example.com", TYPE.A)); // blocked, not allowed
    await proxy.handle(buildQuery(4, "news.example.com", TYPE.A)); // forwarded, never touched either list's allow side
    expect(proxy.stats).toMatchObject({ total: 4, allowed: 2, blocked: 1, forwarded: 2, cacheHits: 1 });
  });

  it("a proxy constructed with NO allowlist configured behaves identically to Stage 1 (backward compatible)", async () => {
    const { proxy, stub } = await harness(() => answer, { blocked: ["ads.example.com"] }); // no `allowed` option at all
    const blocked = decodeResponse((await proxy.handle(buildQuery(1, "ads.example.com", TYPE.A)))!);
    expect(blocked.header.rcode).toBe(RCODE.NXDOMAIN);
    const forwarded = decodeResponse((await proxy.handle(buildQuery(2, "news.example.com", TYPE.A)))!);
    expect(forwarded.header.rcode).toBe(RCODE.NOERROR);
    expect(stub.callCount).toBe(1);
    expect(proxy.stats.allowed).toBe(0);
  });
});

describe("caching", () => {
  it("a repeated identical query within the TTL never calls upstream a second time", async () => {
    const { proxy, stub } = await harness(() => answer);
    await proxy.handle(buildQuery(1, "news.example.com", TYPE.A));
    await proxy.handle(buildQuery(2, "news.example.com", TYPE.A));
    await proxy.handle(buildQuery(3, "news.example.com", TYPE.A));
    expect(stub.callCount).toBe(1);
  });

  it("a cache hit still carries the new request's own transaction id", async () => {
    const { proxy } = await harness(() => answer);
    await proxy.handle(buildQuery(1, "news.example.com", TYPE.A));
    const second = decodeResponse((await proxy.handle(buildQuery(0x4242, "news.example.com", TYPE.A)))!);
    expect(second.header.id).toBe(0x4242);
  });

  it("after the TTL elapses (ManualClock), the next query calls upstream again and gets a fresh TTL", async () => {
    const clock = new ManualClock(0);
    const { proxy, stub } = await harness(() => ({ kind: "answer", ttl: 30, address: "203.0.113.5" }), { clock });
    await proxy.handle(buildQuery(1, "news.example.com", TYPE.A));
    expect(stub.callCount).toBe(1);
    clock.advance(29_000);
    await proxy.handle(buildQuery(2, "news.example.com", TYPE.A)); // still within TTL
    expect(stub.callCount).toBe(1);
    clock.advance(1_000); // now at 30s: expired
    await proxy.handle(buildQuery(3, "news.example.com", TYPE.A));
    expect(stub.callCount).toBe(2); // fetched again
  });

  it("a cache hit's answer TTL is counted down by elapsed time, like a real resolver's cache", async () => {
    const clock = new ManualClock(0);
    const { proxy } = await harness(() => ({ kind: "answer", ttl: 300, address: "203.0.113.5" }), { clock });
    await proxy.handle(buildQuery(1, "news.example.com", TYPE.A));
    clock.advance(10_000);
    const hit = decodeResponse((await proxy.handle(buildQuery(2, "news.example.com", TYPE.A)))!);
    expect(hit.answers[0]!.ttl).toBe(290);
  });

  it("different query types for the same name are cached independently", async () => {
    const { proxy, stub } = await harness(() => answer);
    await proxy.handle(buildQuery(1, "news.example.com", TYPE.A));
    await proxy.handle(buildQuery(2, "news.example.com", TYPE.AAAA));
    expect(stub.callCount).toBe(2);
  });

  it("an NXDOMAIN (no answer records) from upstream is relayed but not cached", async () => {
    const { proxy, stub } = await harness(() => ({ kind: "nxdomain" }));
    await proxy.handle(buildQuery(1, "missing.test", TYPE.A));
    await proxy.handle(buildQuery(2, "missing.test", TYPE.A));
    expect(stub.callCount).toBe(2); // asked upstream again, since nothing was cached
  });
});

describe("TCP fallback on a truncated upstream reply", () => {
  it("a TC=1 UDP reply triggers a TCP retry, and the client gets the full, non-truncated answer", async () => {
    const { proxy, stub } = await harness(() => ({ kind: "truncate", ttl: 300, address: "203.0.113.9" }));
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "big.test", TYPE.A)))!);
    expect(reply.header.tc).toBe(false);
    expect(reply.answers).toHaveLength(1);
    expect(stub.calls.map((c) => c.transport)).toEqual(["udp", "tcp"]);
  });

  it("a TCP-retrieved answer is still cached with its own TTL", async () => {
    const { proxy, stub } = await harness(() => ({ kind: "truncate", ttl: 300, address: "203.0.113.9" }));
    await proxy.handle(buildQuery(1, "big.test", TYPE.A));
    await proxy.handle(buildQuery(2, "big.test", TYPE.A));
    expect(stub.callCount).toBe(2); // one UDP + one TCP call for the FIRST query only
  });
});

describe("upstream failure", () => {
  it("a dropped (timed out) upstream query returns SERVFAIL promptly, never hangs", async () => {
    const { proxy } = await harness(() => ({ kind: "drop" }), { udpTimeoutMs: 80, tcpTimeoutMs: 80 });
    const started = Date.now();
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "dead.test", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.SERVFAIL);
    expect(reply.header.id).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a SERVFAIL response is never cached", async () => {
    const { proxy, stub } = await harness(() => ({ kind: "drop" }), { udpTimeoutMs: 80, tcpTimeoutMs: 80 });
    await proxy.handle(buildQuery(1, "dead.test", TYPE.A));
    await proxy.handle(buildQuery(2, "dead.test", TYPE.A));
    expect(stub.callCount).toBe(2); // tried upstream again, nothing was wrongly cached
  });

  it("an upstream reply with a transaction id that does not match the query is treated as a failure, not relayed", async () => {
    const { proxy } = await harness(() => ({ kind: "wrong-id", ttl: 60, address: "203.0.113.5" }));
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "a.test", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.SERVFAIL);
    expect(reply.header.id).toBe(1); // still answers the CLIENT with its own id, just not the upstream's bad answer
  });

  it("upstream unreachable (nothing listening on that port) also returns SERVFAIL", async () => {
    const clock = new ManualClock(0);
    const proxy = new SinkholeProxy({
      blockList: new BlockList([]),
      mode: "nxdomain",
      upstream: { host: "127.0.0.1", port: 1 }, // nothing listens here
      udpTimeoutMs: 150,
      tcpTimeoutMs: 150,
      cache: new ResponseCache({ clock }),
    });
    const reply = decodeResponse((await proxy.handle(buildQuery(1, "x.test", TYPE.A)))!);
    expect(reply.header.rcode).toBe(RCODE.SERVFAIL);
  });
});

describe("malformed and unusual queries", () => {
  it("fewer than 12 bytes gets no reply at all (nothing to answer to)", async () => {
    const { proxy } = await harness(() => answer);
    expect(await proxy.handle(Buffer.alloc(5))).toBeUndefined();
  });

  it("a packet with QR=1 (a response, not a query) is dropped, never answered", async () => {
    const { proxy, stub } = await harness(() => answer);
    const q = buildQuery(1, "news.example.com", TYPE.A);
    q[2] = q[2]! | 0x80; // set QR
    expect(await proxy.handle(q)).toBeUndefined();
    expect(stub.callCount).toBe(0);
  });

  it("zero questions is FORMERR; two questions is FORMERR", async () => {
    const { proxy } = await harness(() => answer);
    const zero = encodeMessage(emptyHeader(1), [], []);
    expect(decodeResponse((await proxy.handle(zero))!).header.rcode).toBe(RCODE.FORMERR);
    const two = encodeMessage(emptyHeader(2), [
      { name: "a.test", type: TYPE.A, class: CLASS_IN },
      { name: "b.test", type: TYPE.A, class: CLASS_IN },
    ], []);
    expect(decodeResponse((await proxy.handle(two))!).header.rcode).toBe(RCODE.FORMERR);
  });

  it("a non-QUERY opcode is NOTIMP", async () => {
    const { proxy } = await harness(() => answer);
    const q = buildQuery(1, "a.test", TYPE.A);
    q[2] = (q[2]! & 0x87) | (2 << 3); // opcode = STATUS (2)
    expect(decodeResponse((await proxy.handle(q))!).header.rcode).toBe(RCODE.NOTIMP);
  });

  it("a non-IN class is NOTIMP", async () => {
    const { proxy } = await harness(() => answer);
    const q = encodeMessage(emptyHeader(1), [{ name: "a.test", type: TYPE.A, class: 3 }], []); // CHAOS
    expect(decodeResponse((await proxy.handle(q))!).header.rcode).toBe(RCODE.NOTIMP);
  });
});

describe("stats", () => {
  it("counts blocked, cache hits, forwarded and servfail outcomes", async () => {
    const { proxy } = await harness(() => answer, { blocked: ["ads.test"] });
    await proxy.handle(buildQuery(1, "ads.test", TYPE.A)); // blocked
    await proxy.handle(buildQuery(2, "news.test", TYPE.A)); // forwarded
    await proxy.handle(buildQuery(3, "news.test", TYPE.A)); // cache hit
    expect(proxy.stats).toMatchObject({ total: 3, blocked: 1, forwarded: 1, cacheHits: 1, servfail: 0 });
  });
});
