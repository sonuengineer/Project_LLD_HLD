/**
 * Resolver cache: positive RRsets and negative answers (RFC 2308), all with TTLs.
 *
 * - Positive entries are whole RRsets keyed by (canonical name, type). The TTL of the set is the SMALLEST TTL of its
 *   records (RFC 2181 5.2 says they should all be equal; when they are not, the smallest is the safe choice).
 * - Negative entries: NXDOMAIN is about the NAME (no type exists there), NODATA is about (name, type). The TTL is
 *   min(SOA record TTL, SOA minimum field) (RFC 2308 section 5). A negative answer without an SOA is not cached.
 * - Ranking (a small version of RFC 2181 5.4.1): data learnt from a referral (NS sets and glue in authority /
 *   additional) is "referral" rank; data from an answer section is "answer" rank. A referral never overwrites an
 *   unexpired answer, and referral data is used to find servers but never handed to a client as an answer.
 * - Every TTL is capped at maxTtl (default 1 day), so a hostile or mistaken huge TTL cannot pin data forever.
 * - Time comes from an injected clock (ms), so tests move time instead of sleeping.
 */
import { canonicalName, type ResourceRecord, type RData } from "./wire.js";

export type Rank = "referral" | "answer";
const RANK_ORDER: Record<Rank, number> = { referral: 1, answer: 2 };

export type NegativeKind = "NXDOMAIN" | "NODATA";

interface PositiveEntry {
  rrs: ResourceRecord[];
  expiresAt: number;
  rank: Rank;
}

interface NegativeEntry {
  kind: NegativeKind;
  soa: ResourceRecord;
  expiresAt: number;
}

export interface CacheOptions {
  now?: () => number;
  /** seconds, default 86400 */
  maxTtl?: number;
  /** seconds, default 10800 (3 hours, the cap RFC 2308 suggests for negative answers) */
  maxNegativeTtl?: number;
  /** default 10000; the oldest entry is evicted first when full */
  maxEntries?: number;
}

export interface NegativeHit {
  kind: NegativeKind;
  /** the SOA with its TTL counted down */
  soa: ResourceRecord;
}

const posKey = (name: string, type: number) => `${canonicalName(name)}|${type}`;
const nxKey = (name: string) => `${canonicalName(name)}|NX`;

export class Cache {
  private readonly now: () => number;
  private readonly maxTtl: number;
  private readonly maxNegativeTtl: number;
  private readonly maxEntries: number;
  private readonly positive = new Map<string, PositiveEntry>();
  private readonly negative = new Map<string, NegativeEntry>();

  constructor(opts: CacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxTtl = opts.maxTtl ?? 86_400;
    this.maxNegativeTtl = opts.maxNegativeTtl ?? 10_800;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  get size(): number {
    return this.positive.size + this.negative.size;
  }

  clear() {
    this.positive.clear();
    this.negative.clear();
  }

  /** Stores one RRset (all records must share name and type). Returns false if it was not stored. */
  putRRset(rrs: ResourceRecord[], rank: Rank): boolean {
    const first = rrs[0];
    if (!first) return false;
    const ttl = Math.min(this.maxTtl, ...rrs.map((r) => r.ttl));
    if (ttl <= 0) return false; // TTL 0 means "use once, do not cache"
    const key = posKey(first.name, first.type);
    const old = this.positive.get(key);
    if (old && old.expiresAt > this.now() && RANK_ORDER[old.rank] > RANK_ORDER[rank]) return false;
    this.positive.delete(key); // re-insert so Map order is age order
    this.positive.set(key, { rrs: rrs.map((r) => ({ ...r, data: copyData(r.data) })), expiresAt: this.now() + ttl * 1000, rank });
    // positive data for a name means an old "this name does not exist" is wrong now
    this.negative.delete(nxKey(first.name));
    this.negative.delete(posKey(first.name, first.type));
    this.evict();
    return true;
  }

  /** The RRset with TTLs counted down to the remaining whole seconds, or undefined. */
  getRRset(name: string, type: number, minRank: Rank = "answer"): ResourceRecord[] | undefined {
    const key = posKey(name, type);
    const e = this.positive.get(key);
    if (!e) return undefined;
    const left = e.expiresAt - this.now();
    if (left <= 0) {
      this.positive.delete(key);
      return undefined;
    }
    if (RANK_ORDER[e.rank] < RANK_ORDER[minRank]) return undefined;
    const ttl = Math.floor(left / 1000);
    return e.rrs.map((r) => ({ ...r, ttl, data: copyData(r.data) }));
  }

  /**
   * Stores a negative answer. `soa` is the SOA from the authority section; without one nothing is cached.
   * Returns the TTL used, or 0 if not stored.
   */
  putNegative(name: string, type: number, kind: NegativeKind, soa: ResourceRecord | undefined): number {
    if (!soa || soa.data.kind !== "SOA") return 0;
    const ttl = Math.min(soa.ttl, soa.data.minimum, this.maxNegativeTtl);
    if (ttl <= 0) return 0;
    const key = kind === "NXDOMAIN" ? nxKey(name) : posKey(name, type);
    this.negative.delete(key);
    this.negative.set(key, { kind, soa: { ...soa, data: copyData(soa.data) }, expiresAt: this.now() + ttl * 1000 });
    this.evict();
    return ttl;
  }

  getNegative(name: string, type: number): NegativeHit | undefined {
    for (const key of [nxKey(name), posKey(name, type)]) {
      const e = this.negative.get(key);
      if (!e) continue;
      const left = e.expiresAt - this.now();
      if (left <= 0) {
        this.negative.delete(key);
        continue;
      }
      return { kind: e.kind, soa: { ...e.soa, ttl: Math.floor(left / 1000), data: copyData(e.soa.data) } };
    }
    return undefined;
  }

  private evict() {
    while (this.size > this.maxEntries) {
      // drop from the bigger map first; Map iteration order is insertion order, so this is the oldest entry
      const map = this.positive.size >= this.negative.size ? this.positive : this.negative;
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
}

function copyData(d: RData): RData {
  if (d.kind === "TXT") return { ...d, texts: [...d.texts] };
  if (d.kind === "RAW") return { ...d, bytes: Buffer.from(d.bytes) };
  return { ...d };
}
