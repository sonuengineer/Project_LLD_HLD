/**
 * OPT-IN live test (LIVE_DNS=1): resolves real names from the REAL root servers over the internet.
 * It needs outbound UDP (and TCP) to port 53; many corporate or cloud networks block that, then it fails.
 * node:dns is used ONLY here, as an independent check of our answers:
 *  - dns.lookup() (the operating system's getaddrinfo) for A records -- works on any machine with working DNS;
 *  - dns.Resolver (c-ares) for MX and NXDOMAIN, ONLY if LIVE_DNS_CHECK_SERVER=<ip> names a resolver to ask. On the
 *    machine this was written on, c-ares picked 127.0.0.1 as its server and got ECONNREFUSED, so without that variable
 *    those two cross-checks are skipped and only our own answers are checked.
 */
import { promises as dns } from "node:dns";
import { describe, expect, it } from "vitest";
import { Resolver } from "../src/resolver.js";
import { RCODE, TYPE, type ResourceRecord } from "../src/wire.js";

const live = process.env.LIVE_DNS === "1";
const checkServer = process.env.LIVE_DNS_CHECK_SERVER;
const cares = new dns.Resolver();
if (checkServer) cares.setServers([checkServer]);
const osLookup4 = async (name: string) => (await dns.lookup(name, { all: true, family: 4 })).map((a) => a.address).sort();
const addrs = (rrs: ResourceRecord[], kind: "A" | "AAAA") => rrs.flatMap((r) => (r.data.kind === kind ? [r.data.address] : [])).sort();

describe.skipIf(!live)("live: real root servers (LIVE_DNS=1)", () => {
  const lines: string[] = [];
  const resolver = new Resolver({ timeoutMs: 3000, trace: (l) => lines.push(l) });

  it("a.root-servers.net A and AAAA: same as our own root hints, and the same as the OS resolver", async () => {
    const a = await resolver.resolve("a.root-servers.net", TYPE.A);
    expect(a.rcode).toBe(RCODE.NOERROR);
    expect(addrs(a.answers, "A")).toEqual(["198.41.0.4"]);
    expect(addrs(a.answers, "A")).toEqual(await osLookup4("a.root-servers.net"));
    const aaaa = await resolver.resolve("a.root-servers.net", TYPE.AAAA);
    expect(addrs(aaaa.answers, "AAAA")).toEqual(["2001:503:ba3e::2:30"]);
  }, 30_000);

  it("example.com A: non-empty, and the same set the OS resolver gets", async () => {
    const r = await resolver.resolve("example.com", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    const ours = addrs(r.answers, "A");
    expect(ours.length).toBeGreaterThan(0);
    expect(ours).toEqual(await osLookup4("example.com"));
  }, 30_000);

  it("www.wikipedia.org: follows a CNAME chain to addresses", async () => {
    const r = await resolver.resolve("www.wikipedia.org", TYPE.A);
    expect(r.rcode).toBe(RCODE.NOERROR);
    expect(r.answers.some((x) => x.type === TYPE.CNAME)).toBe(true);
    expect(addrs(r.answers, "A").length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!checkServer)("MX of gmail.com matches node:dns (needs LIVE_DNS_CHECK_SERVER)", async () => {
    const r = await resolver.resolve("gmail.com", TYPE.MX);
    const ours = r.answers.flatMap((x) => (x.data.kind === "MX" ? [`${x.data.preference} ${x.data.exchange.toLowerCase()}`] : [])).sort();
    const theirs = (await cares.resolveMx("gmail.com")).map((m) => `${m.priority} ${m.exchange.toLowerCase()}`).sort();
    expect(ours).toEqual(theirs);
  }, 30_000);

  it("a name under the reserved .invalid TLD is NXDOMAIN straight from a root server", async () => {
    const r = await resolver.resolve("does-not-exist.invalid", TYPE.A);
    expect(r.rcode).toBe(RCODE.NXDOMAIN);
    expect(r.authority[0]?.type).toBe(TYPE.SOA);
    if (checkServer) await expect(cares.resolve4("does-not-exist.invalid")).rejects.toMatchObject({ code: "ENOTFOUND" });
  }, 30_000);

  it("prints the trace of the first lookup (for the README)", () => {
    console.log(lines.slice(0, 25).join("\n"));
    expect(lines.length).toBeGreaterThan(0);
  });
});
