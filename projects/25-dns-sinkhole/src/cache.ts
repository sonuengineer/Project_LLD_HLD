/**
 * Response cache: the raw bytes of an upstream reply, keyed by (name, type), kept until the smallest TTL among its
 * answer records runs out.
 *
 * Lazy expiry, no background sweep: an expired entry is only ever noticed and dropped on the next lookup that
 * hits its key (same philosophy as 23-password-manager's session idle timeout). Recommended over a periodic
 * sweep here for the same reason it is recommended there: a sweep needs a timer that outlives individual
 * requests, with its own start/stop lifecycle and a place to get the clock from when nothing is asking it a
 * question right now -- real cost for a benefit this cache does not need. The only downside of lazy expiry, an
 * expired-but-never-looked-up-again entry sitting in memory forever, is bounded here by `maxEntries` (oldest
 * insertion evicted first), the same safety valve 15-dns-resolver's cache uses.
 *
 * We cache raw bytes, not parsed records: see wire.ts's file header for why (rdata we do not understand can
 * contain compressed names that are only valid at their original byte offset). A cache hit for a different client
 * just gets its own transaction ID patched into a copy of those bytes before it is sent.
 */
import { systemClock, type Clock } from "./clock.js";

interface Entry {
  buf: Buffer;
  expiresAt: number;
  insertedAt: number;
  /** Byte offsets of each answer record's 4-byte TTL field (see wire.ts AnswerMeta.ttlOffset). */
  ttlOffsets: number[];
}

export interface ResponseCacheOptions {
  clock?: Clock;
  /** Safety cap; the oldest entry (by insertion) is evicted first when full. Default 10_000. */
  maxEntries?: number;
}

const key = (name: string, type: number): string => `${name.toLowerCase().replace(/\.$/, "")}|${type}`;

export class ResponseCache {
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: ResponseCacheOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Stores a raw response for (name, type) for ttlSeconds. `ttlOffsets` are the byte offsets of each answer
   * record's TTL field (wire.ts's AnswerMeta.ttlOffset) -- used so a later get() can hand back TTLs counted down
   * by elapsed time, same as a real resolver's cache, without touching anything else in the buffer. ttlSeconds
   * <= 0 means "do not cache"; returns whether it was stored.
   */
  put(name: string, type: number, buf: Buffer, ttlSeconds: number, ttlOffsets: number[] = []): boolean {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
    const k = key(name, type);
    this.entries.delete(k); // delete-then-set so Map iteration order (used for eviction) stays age order
    this.entries.set(k, { buf: Buffer.from(buf), expiresAt: this.clock.now() + ttlSeconds * 1000, insertedAt: this.clock.now(), ttlOffsets });
    this.evict();
    return true;
  }

  /**
   * The cached raw response, or undefined if absent or expired. An expired entry is dropped right here. Each
   * answer's TTL field is counted down by the time elapsed since it was stored (floored to whole seconds);
   * this can never go negative because the whole entry is evicted once the SMALLEST original TTL elapses.
   */
  get(name: string, type: number): Buffer | undefined {
    const k = key(name, type);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= this.clock.now()) {
      this.entries.delete(k); // lazy eviction: only happens because THIS lookup found it stale
      return undefined;
    }
    const out = Buffer.from(e.buf);
    const elapsedSeconds = Math.floor((this.clock.now() - e.insertedAt) / 1000);
    for (const offset of e.ttlOffsets) {
      const original = out.readUInt32BE(offset);
      out.writeUInt32BE(Math.max(0, original - elapsedSeconds), offset);
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
