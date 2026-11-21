/**
 * Iterative ("recursive" from the client's point of view) resolution, starting at the root servers.
 *
 * resolve(name, type):
 *   follow the CNAME chain, at most maxCnameChain links; for each link, resolveOne():
 *     1. cache: positive answer, negative answer, or a cached CNAME for the name
 *     2. find the closest zone cut we already know servers for (cached NS + addresses), else the root hints
 *     3. ask that zone's servers (RD=0). Each response is one of:
 *          answer     -> cache it, done
 *          CNAME      -> cache it, the caller follows the target
 *          referral   -> NS records for a zone BELOW the current one and above the name: go one level down,
 *                        using glue if the response had in-bailiwick glue, else resolving the NS names first
 *                        ("out-of-bailiwick" NS lookup, a nested resolution with its own depth limit)
 *          NXDOMAIN / NODATA -> negative-cache with the SOA minimum (RFC 2308), done
 *          lame / broken / timeout / SERVFAIL / REFUSED -> try the next server of the same zone
 *
 * Bailiwick: when we ask a server for zone Z, ONLY records at or below Z are believed (answers, glue, SOA). A server
 * for example.test can say nothing about bank.test, so a poisoned extra record in its response is dropped before it
 * reaches the cache. This is the defence against the "extra records" half of a Kaminsky attack; the random ID and
 * port in transport.ts are the defence against the guessing half.
 *
 * Every resolve() has a budget of maxQueries upstream queries in total (nested NS lookups included) and a nesting
 * limit maxDepth, so delegation loops and very deep chains end in SERVFAIL instead of running forever.
 */
import { randomInt } from "node:crypto";
import { Cache } from "./cache.js";
import { ROOT_HINTS, type RootHint } from "./root-hints.js";
import { TimeoutError, TransportError, queryTcp, queryUdp, randomId, type Endpoint, type IgnoreReason } from "./transport.js";
import {
  CLASS_IN,
  RCODE,
  TYPE,
  WireError,
  buildQuery,
  canonicalName,
  isSubdomain,
  parentName,
  rcodeName,
  sameName,
  typeName,
  type Message,
  type ResourceRecord,
} from "./wire.js";

export interface ResolverOptions {
  rootHints?: readonly RootHint[];
  /** maps a server IP to the socket to use; default `{ host: ip, port: 53 }`. Tests map to a fake network. */
  route?: (ip: string) => Endpoint;
  /** per query, default 2000 */
  timeoutMs?: number;
  /** upstream queries per resolve(), nested lookups included, default 60 */
  maxQueries?: number;
  /** CNAME links per resolve(), default 8 */
  maxCnameChain?: number;
  /** nested NS-address lookups, default 4 */
  maxDepth?: number;
  /** referrals per lookup, default 16 (a name has at most 127 labels, real chains are 3-5 deep) */
  maxReferrals?: number;
  cache?: Cache;
  /** randomise the order servers of a zone are tried in, default true */
  shuffle?: boolean;
  /** one line per upstream query and decision */
  trace?: (line: string) => void;
  /** every UDP reply the transport ignored (spoofed, undecodable, mismatched) */
  onIgnored?: (reason: IgnoreReason, server: string) => void;
}

export interface Resolution {
  rcode: number;
  /** CNAME chain (in order) followed by the final RRset; empty for NXDOMAIN / NODATA */
  answers: ResourceRecord[];
  /** the SOA for a negative answer, when known */
  authority: ResourceRecord[];
  /** upstream queries this resolution sent (0 = fully from cache) */
  queries: number;
  /** why it failed, for SERVFAIL */
  reason?: string;
}

export class ResolveError extends Error {
  override name = "ResolveError";
}

interface Server {
  name: string;
  ip: string;
}

interface Ctx {
  budget: { queries: number };
  depth: number;
}

type Outcome =
  | { kind: "answer"; rrs: ResourceRecord[] }
  | { kind: "cname"; rr: ResourceRecord }
  | { kind: "negative"; rcode: number; soa?: ResourceRecord }
  | { kind: "referral"; zone: string; hosts: string[]; glue: Map<string, string[]> }
  | { kind: "lame"; why: string };

const isIn = (rr: ResourceRecord) => rr.class === CLASS_IN;

export class Resolver {
  readonly cache: Cache;
  private readonly hints: readonly RootHint[];
  private readonly route: (ip: string) => Endpoint;
  private readonly timeoutMs: number;
  private readonly maxQueries: number;
  private readonly maxCnameChain: number;
  private readonly maxDepth: number;
  private readonly maxReferrals: number;
  private readonly shuffle: boolean;
  private readonly trace: (line: string) => void;
  private readonly onIgnored?: (reason: IgnoreReason, server: string) => void;

  constructor(opts: ResolverOptions = {}) {
    this.cache = opts.cache ?? new Cache();
    this.hints = opts.rootHints ?? ROOT_HINTS;
    this.route = opts.route ?? ((ip) => ({ host: ip, port: 53 }));
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.maxQueries = opts.maxQueries ?? 60;
    this.maxCnameChain = opts.maxCnameChain ?? 8;
    this.maxDepth = opts.maxDepth ?? 4;
    this.maxReferrals = opts.maxReferrals ?? 16;
    this.shuffle = opts.shuffle ?? true;
    this.trace = opts.trace ?? (() => {});
    this.onIgnored = opts.onIgnored;
  }

  async resolve(name: string, type: number): Promise<Resolution> {
    const ctx: Ctx = { budget: { queries: 0 }, depth: 0 };
    try {
      return { ...(await this.resolveChain(name, type, ctx)), queries: ctx.budget.queries };
    } catch (e) {
      if (e instanceof ResolveError || e instanceof WireError) {
        this.trace(`SERVFAIL ${name} ${typeName(type)}: ${e.message}`);
        return { rcode: RCODE.SERVFAIL, answers: [], authority: [], queries: ctx.budget.queries, reason: e.message };
      }
      throw e;
    }
  }

  private async resolveChain(qname: string, qtype: number, ctx: Ctx): Promise<Omit<Resolution, "queries">> {
    const chain: ResourceRecord[] = [];
    let name = qname;
    for (let links = 0; ; links++) {
      const out = await this.resolveOne(name, qtype, ctx);
      if (out.kind === "cname") {
        if (links >= this.maxCnameChain) throw new ResolveError(`CNAME chain longer than ${this.maxCnameChain} at ${name}`);
        chain.push(out.rr);
        name = (out.rr.data as { target: string }).target;
        continue;
      }
      if (out.kind === "answer") return { rcode: RCODE.NOERROR, answers: [...chain, ...out.rrs], authority: [] };
      if (out.kind === "negative") return { rcode: out.rcode, answers: chain, authority: out.soa ? [out.soa] : [] };
      throw new ResolveError(`unexpected outcome ${out.kind}`);
    }
  }

  private async resolveOne(name: string, type: number, ctx: Ctx): Promise<Outcome> {
    const hit = this.cache.getRRset(name, type, "answer");
    if (hit) return { kind: "answer", rrs: hit };
    const neg = this.cache.getNegative(name, type);
    if (neg) return { kind: "negative", rcode: neg.kind === "NXDOMAIN" ? RCODE.NXDOMAIN : RCODE.NOERROR, soa: neg.soa };
    if (type !== TYPE.CNAME) {
      const cname = this.cache.getRRset(name, TYPE.CNAME, "answer");
      if (cname?.[0]) return { kind: "cname", rr: cname[0] };
    }

    let { zone, servers } = this.closestServers(name);
    for (let referrals = 0; referrals <= this.maxReferrals; referrals++) {
      const out = await this.askZone(zone, servers, name, type, ctx);
      if (out.kind !== "referral") return out;
      this.trace(`referral ${zone || "."} -> ${out.zone} (${out.hosts.join(", ")})`);
      zone = out.zone;
      servers = await this.serversFor(out.hosts, out.glue, ctx);
    }
    throw new ResolveError(`more than ${this.maxReferrals} referrals for ${name}`);
  }

  /** The deepest ancestor of `name` whose NS set and at least one NS address are cached; the root otherwise. */
  private closestServers(name: string): { zone: string; servers: Server[] } {
    for (let zone = canonicalName(name); zone !== ""; zone = parentName(zone)) {
      const ns = this.cache.getRRset(zone, TYPE.NS, "referral");
      if (!ns) continue;
      const servers = this.cachedAddresses(ns.map((r) => (r.data as { host: string }).host));
      if (servers.length) return { zone, servers };
    }
    return { zone: "", servers: this.hints.map((h) => ({ name: h.name, ip: h.ipv4 })) };
  }

  private cachedAddresses(hosts: string[]): Server[] {
    const out: Server[] = [];
    for (const host of hosts) {
      for (const a of this.cache.getRRset(host, TYPE.A, "referral") ?? []) {
        if (a.data.kind === "A") out.push({ name: host, ip: a.data.address });
      }
    }
    return out;
  }

  /** Addresses for a new zone's servers: glue first, then the cache, then (one host at a time) a nested lookup. */
  private async serversFor(hosts: string[], glue: Map<string, string[]>, ctx: Ctx): Promise<Server[]> {
    const out: Server[] = [];
    for (const h of hosts) for (const ip of glue.get(h.toLowerCase()) ?? []) out.push({ name: h, ip });
    if (out.length) return out;
    const cached = this.cachedAddresses(hosts);
    if (cached.length) return cached;
    if (ctx.depth >= this.maxDepth) throw new ResolveError(`NS lookups nested deeper than ${this.maxDepth}`);
    for (const host of hosts) {
      this.trace(`no glue: resolving NS host ${host}`);
      const r = await this.resolveChain(host, TYPE.A, { budget: ctx.budget, depth: ctx.depth + 1 }).catch((e) => {
        if (e instanceof ResolveError) return undefined; // try the next NS host, unless the budget is gone
        throw e;
      });
      if (ctx.budget.queries >= this.maxQueries) break;
      const ips = (r?.answers ?? []).flatMap((rr) => (rr.data.kind === "A" ? [rr.data.address] : []));
      if (ips.length) return ips.map((ip) => ({ name: host, ip }));
    }
    throw new ResolveError(`no address found for any NS host: ${hosts.join(", ")}`);
  }

  /** Asks the servers of `zone` one after another until one gives a usable response. */
  private async askZone(zone: string, servers: Server[], name: string, type: number, ctx: Ctx): Promise<Outcome> {
    const order = this.shuffle ? shuffled(servers) : servers;
    const failures: string[] = [];
    for (const s of order) {
      if (ctx.budget.queries >= this.maxQueries) throw new ResolveError(`query budget of ${this.maxQueries} used up`);
      ctx.budget.queries++;
      let reply: Message;
      try {
        reply = await this.exchange(s, name, type);
      } catch (e) {
        if (e instanceof TimeoutError || e instanceof TransportError || e instanceof WireError) {
          this.trace(`  ${s.name} (${s.ip}): ${e.message}`);
          failures.push(`${s.ip}: ${e.name}`);
          continue;
        }
        throw e;
      }
      const rcode = reply.header.rcode;
      if (rcode !== RCODE.NOERROR && rcode !== RCODE.NXDOMAIN) {
        this.trace(`  ${s.name} (${s.ip}): ${rcodeName(rcode)}, next server`);
        failures.push(`${s.ip}: ${rcodeName(rcode)}`);
        continue;
      }
      const out = this.classify(reply, zone, name, type);
      if (out.kind === "lame") {
        this.trace(`  ${s.name} (${s.ip}): lame (${out.why}), next server`);
        failures.push(`${s.ip}: lame`);
        continue;
      }
      return out;
    }
    throw new ResolveError(`all servers for zone "${zone || "."}" failed (${failures.join("; ")})`);
  }

  private async exchange(s: Server, name: string, type: number): Promise<Message> {
    const to = this.route(s.ip);
    const query = buildQuery(randomId(), name, type, false);
    let reply = await queryUdp(to, query, {
      timeoutMs: this.timeoutMs,
      onIgnored: (reason) => {
        this.trace(`  ignored a UDP reply (${reason}) while waiting for ${s.ip}`);
        this.onIgnored?.(reason, s.ip);
      },
    });
    this.trace(`  ${s.name} (${s.ip}) UDP ${name} ${typeName(type)}: ${rcodeName(reply.header.rcode)}${reply.header.tc ? " TC" : ""}`);
    if (reply.header.tc) {
      // Truncated: the UDP reply is incomplete. Ask the SAME server again over TCP, where there is no size limit.
      reply = await queryTcp(to, { ...query, header: { ...query.header, id: randomId() } }, this.timeoutMs);
      this.trace(`  ${s.name} (${s.ip}) TCP retry: ${rcodeName(reply.header.rcode)}`);
    }
    return reply;
  }

  /**
   * Turns a response from a server of `zone` into an outcome. Everything outside `zone` is dropped here (bailiwick),
   * and everything that is kept is cached here.
   */
  private classify(reply: Message, zone: string, name: string, type: number): Outcome {
    const inZone = (rr: ResourceRecord) => isIn(rr) && isSubdomain(rr.name, zone);
    const dropped = [...reply.answers, ...reply.authority, ...reply.additional].filter((rr) => isIn(rr) && !inZone(rr) && rr.type !== TYPE.OPT);
    if (dropped.length) this.trace(`  dropped ${dropped.length} out-of-bailiwick record(s) for zone "${zone || "."}": ${dropped.map((r) => r.name).join(", ")}`);

    const answers = reply.answers.filter(inZone);
    const soa = reply.authority.find((rr) => inZone(rr) && rr.type === TYPE.SOA && isSubdomain(name, rr.name));

    if (reply.header.rcode === RCODE.NXDOMAIN) {
      // The CNAME part of an NXDOMAIN response (alias exists, its target does not) is followed by the caller;
      // here we only learn that `name` does not exist if no CNAME for it came along.
      const cname = answers.find((rr) => rr.type === TYPE.CNAME && sameName(rr.name, name));
      if (cname) {
        this.cacheAnswers(answers);
        return { kind: "cname", rr: cname };
      }
      this.cache.putNegative(name, type, "NXDOMAIN", soa);
      return { kind: "negative", rcode: RCODE.NXDOMAIN, soa };
    }

    const direct = answers.filter((rr) => rr.type === type && sameName(rr.name, name));
    if (direct.length) {
      this.cacheAnswers(answers);
      return { kind: "answer", rrs: direct };
    }
    const cname = answers.find((rr) => rr.type === TYPE.CNAME && sameName(rr.name, name));
    if (cname) {
      this.cacheAnswers(answers);
      return { kind: "cname", rr: cname };
    }

    const ns = reply.authority.filter((rr) => isIn(rr) && rr.type === TYPE.NS);
    const cut = ns[0]?.name;
    if (cut !== undefined && !sameName(cut, zone)) {
      // A real referral points DOWN: to a zone strictly below the one we asked, and at or above the name.
      if (!isSubdomain(cut, zone) || !isSubdomain(name, cut)) return { kind: "lame", why: `referral to "${cut || "."}" from zone "${zone || "."}"` };
      const nsSet = ns.filter((rr) => sameName(rr.name, cut));
      const hosts = nsSet.flatMap((rr) => (rr.data.kind === "NS" ? [rr.data.host] : []));
      this.cache.putRRset(nsSet, "referral");
      const glue = new Map<string, string[]>();
      const hostSet = new Set(hosts.map((h) => h.toLowerCase()));
      const glueRecords = reply.additional.filter((rr) => inZone(rr) && rr.type === TYPE.A && hostSet.has(rr.name.toLowerCase()));
      for (const g of glueRecords) {
        if (g.data.kind !== "A") continue;
        const key = g.name.toLowerCase();
        glue.set(key, [...(glue.get(key) ?? []), g.data.address]);
      }
      for (const set of groupRRsets(glueRecords)) this.cache.putRRset(set, "referral");
      return { kind: "referral", zone: cut, hosts, glue };
    }

    // NOERROR, nothing for our name, no referral: NODATA (the name exists, this type does not).
    if (!reply.header.aa && !soa) return { kind: "lame", why: "empty non-authoritative response" };
    this.cache.putNegative(name, type, "NODATA", soa);
    return { kind: "negative", rcode: RCODE.NOERROR, soa };
  }

  private cacheAnswers(answers: ResourceRecord[]) {
    for (const set of groupRRsets(answers)) this.cache.putRRset(set, "answer");
  }
}

function groupRRsets(rrs: ResourceRecord[]): ResourceRecord[][] {
  const sets = new Map<string, ResourceRecord[]>();
  for (const rr of rrs) {
    const key = `${rr.name.toLowerCase()}|${rr.type}`;
    sets.set(key, [...(sets.get(key) ?? []), rr]);
  }
  return [...sets.values()];
}

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
