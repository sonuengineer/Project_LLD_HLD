/**
 * The sinkhole proxy's decision logic: block, answer from cache, or forward upstream and cache the answer.
 * Pure buffer in, buffer (or undefined) out -- no socket of its own, so it is testable without a real network
 * (see src/server.ts for the UDP listener that calls this, and test/proxy.test.ts for direct unit tests of it).
 */
import { ResponseCache } from "./cache.js";
import type { BlockList } from "./blocklist.js";
import { forwardQuery, type Endpoint } from "./transport.js";
import {
  CLASS_IN,
  OPCODE_QUERY,
  RCODE,
  TYPE,
  WireError,
  canonicalName,
  decodeHeader,
  decodeQuery,
  decodeResponse,
  encodeARecord,
  encodeMessage,
  type Header,
  type Question,
} from "./wire.js";

export type BlockMode = "nxdomain" | "sinkhole";

export interface SinkholeProxyOptions {
  blockList: BlockList;
  /**
   * Optional allowlist (Stage 2). Same shape and same trie-based exact-domain-plus-every-subdomain matching as
   * `blockList` -- it is the identical `BlockList` class, just holding a different set of names (see PLAN.md
   * "Stage 2 decisions" for why one class covers both). A name that matches this list is NEVER blocked, even if
   * it (or an ancestor of it) also matches `blockList` -- unconditionally, regardless of which entry is more
   * specific (this matches Pi-hole's own documented allowlist behaviour; see PLAN.md). Omitting it entirely
   * (the default) reproduces Stage 1's behaviour exactly -- no allowlist check is even reached.
   */
  allowList?: BlockList;
  mode: BlockMode;
  /** IPv4 address returned for a blocked A query in "sinkhole" mode. Default "0.0.0.0". */
  sinkholeAddress?: string;
  /** TTL (seconds) put on a block answer we hand out. Default 60. Never read back by our own cache -- see handle(). */
  sinkholeTtl?: number;
  upstream: Endpoint;
  udpTimeoutMs?: number;
  tcpTimeoutMs?: number;
  cache?: ResponseCache;
}

export interface ProxyStats {
  total: number;
  blocked: number;
  /**
   * Queries that matched the allowlist, so the blocklist check was skipped for them (Stage 2). This is counted
   * SEPARATELY from -- and alongside -- cacheHits/forwarded below: an allowlisted query still goes on to be
   * either a cache hit or a forward, and increments that counter too. `allowed` answers a different question
   * than `forwarded` does: "how many queries were an explicit allowlist override" vs. "how many queries were
   * never going to be blocked in the first place." A query that was simply never on the blocklist is NOT
   * counted here -- only one that actually matched the allowlist is.
   */
  allowed: number;
  cacheHits: number;
  forwarded: number;
  servfail: number;
}

function patchId(buf: Buffer, id: number): Buffer {
  const out = Buffer.from(buf);
  out.writeUInt16BE(id, 0);
  return out;
}

export class SinkholeProxy {
  readonly blockList: BlockList;
  readonly allowList?: BlockList;
  readonly cache: ResponseCache;
  private readonly mode: BlockMode;
  private readonly sinkholeAddress: string;
  private readonly sinkholeTtl: number;
  private readonly upstream: Endpoint;
  private readonly udpTimeoutMs: number;
  private readonly tcpTimeoutMs: number;
  readonly stats: ProxyStats = { total: 0, blocked: 0, allowed: 0, cacheHits: 0, forwarded: 0, servfail: 0 };

  constructor(opts: SinkholeProxyOptions) {
    this.blockList = opts.blockList;
    this.allowList = opts.allowList;
    this.mode = opts.mode;
    this.sinkholeAddress = opts.sinkholeAddress ?? "0.0.0.0";
    this.sinkholeTtl = opts.sinkholeTtl ?? 60;
    this.upstream = opts.upstream;
    this.udpTimeoutMs = opts.udpTimeoutMs ?? 2000;
    this.tcpTimeoutMs = opts.tcpTimeoutMs ?? 2000;
    this.cache = opts.cache ?? new ResponseCache();
  }

  /** One query in, one reply out (or undefined = send nothing). */
  async handle(buf: Buffer): Promise<Buffer | undefined> {
    this.stats.total++;
    let rawHeader: Header;
    try {
      rawHeader = decodeHeader(buf);
    } catch {
      return undefined; // not even 12 bytes: nothing we can answer to
    }
    if (rawHeader.qr) return undefined; // a reply sent to us; never answer one, or two servers could ping-pong

    const base = (rcode: number, questions: Question[] = []): Header => ({
      id: rawHeader.id,
      qr: true,
      opcode: rawHeader.opcode,
      aa: false,
      tc: false,
      rd: rawHeader.rd,
      ra: true,
      rcode,
    });

    let query;
    try {
      query = decodeQuery(buf);
    } catch (e) {
      if (!(e instanceof WireError)) throw e;
      return encodeMessage(base(RCODE.FORMERR), [], []);
    }
    if (query.header.opcode !== OPCODE_QUERY) return encodeMessage(base(RCODE.NOTIMP, query.questions.slice(0, 1)), query.questions.slice(0, 1), []);
    const q = query.questions[0];
    if (!q || query.questions.length !== 1) return encodeMessage(base(RCODE.FORMERR), [], []);
    if (q.class !== CLASS_IN) return encodeMessage(base(RCODE.NOTIMP, [q]), [q], []);

    const name = canonicalName(q.name);

    // Allowlist is checked FIRST and wins unconditionally: if it matches, the blocklist is never even
    // consulted for this query, so a narrower allowed subdomain beats a broader blocked parent AND a broader
    // allowed parent beats a narrower blocked subdomain -- same "always wins" rule either way (see PLAN.md
    // "Stage 2 decisions"). This is also why one shared `isBlocked`-style trie lookup is enough: there is no
    // specificity comparison to make, just "does this query match the allowlist at all."
    const allowed = this.allowList?.isBlocked(name) ?? false;
    if (allowed) this.stats.allowed++;

    if (!allowed && this.blockList.isBlocked(name)) {
      this.stats.blocked++;
      return this.buildBlockResponse(base, q);
    }

    const cached = this.cache.get(name, q.type);
    if (cached) {
      this.stats.cacheHits++;
      return patchId(cached, rawHeader.id);
    }

    try {
      const replyBuf = await forwardQuery(buf, this.upstream, { udpTimeoutMs: this.udpTimeoutMs, tcpTimeoutMs: this.tcpTimeoutMs });
      const parsed = decodeResponse(replyBuf);
      if (!parsed.header.qr || parsed.header.id !== rawHeader.id) throw new WireError("upstream reply did not match our query");
      if (parsed.header.rcode === RCODE.NOERROR && parsed.answers.length > 0) {
        const ttl = Math.min(...parsed.answers.map((a) => a.ttl));
        const ttlOffsets = parsed.answers.map((a) => a.ttlOffset);
        this.cache.put(name, q.type, replyBuf, ttl, ttlOffsets);
      }
      this.stats.forwarded++;
      return replyBuf;
    } catch {
      this.stats.servfail++;
      return encodeMessage(base(RCODE.SERVFAIL, [q]), [q], []);
    }
  }

  private buildBlockResponse(base: (rcode: number, questions?: Question[]) => Header, q: Question): Buffer {
    if (this.mode === "nxdomain" || q.type !== TYPE.A) {
      // Sinkholing is only implemented for A records (see PLAN.md "Not in scope"); every other query type in
      // sinkhole mode still gets NXDOMAIN, same as nxdomain mode.
      return encodeMessage(base(RCODE.NXDOMAIN, [q]), [q], []);
    }
    const rr = encodeARecord(q.name, this.sinkholeTtl, this.sinkholeAddress);
    return encodeMessage(base(RCODE.NOERROR, [q]), [q], [rr]);
  }
}
