import { randomUUID } from "node:crypto";
import type { LoadContext, Loader, LoadOptions, LruCache, SetOptions } from "./cache.js";

// ---------------------------------------------------------------------------------------------------------------
// Bring your own Redis client: the few commands the L2 needs, as tiny structural interfaces, so ANY client fits and
// this package has no runtime dependency on a Redis library (the same pattern as projects/19-rate-limit's
// RedisStore). Adapters for ioredis are below; for node-redis write the same five lines.
// ---------------------------------------------------------------------------------------------------------------

export interface L2Client {
  // The value and its remaining TTL in ms, read ATOMICALLY (ioredis: MULTI GET + PTTL), so the TTL belongs to the
  // value. [null, -2] when the key does not exist; a pttl of -1 means the key has no expiry.
  getWithTtl(key: string): Promise<[value: string | null, pttlMs: number]>;
  // ttlMs: a whole number of ms (SET ... PX), or undefined = no expiry. onlyIfAbsent: SET ... NX; must resolve to
  // null when the key existed and nothing was written (what Redis replies), anything else when it wrote.
  set(key: string, value: string, ttlMs: number | undefined, onlyIfAbsent: boolean): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}

// Why a SECOND connection: a Redis connection that has run SUBSCRIBE is in subscriber mode and (in RESP2, the
// default for ioredis 5) may run only (UN)SUBSCRIBE / PING / QUIT -- no GET or SET. So the cache needs one ordinary
// connection for commands (L2Client) and one dedicated to listening (L2Subscriber), e.g. `redis.duplicate()`.
export interface L2Subscriber {
  // Subscribe to `channel`. Call onMessage for every message on it. After every RE-connection, once the channel is
  // subscribed again, call onResubscribed: messages published while the connection was down are lost (pub/sub is
  // fire-and-forget), so the cache must assume it missed some. Resolves once subscribed, to an unsubscribe function.
  subscribe(channel: string, onMessage: (message: string) => void, onResubscribed: () => void): Promise<() => Promise<void>>;
}

// Structural slices of ioredis (no import of ioredis here; it is a dev dependency for the tests only).
interface IoredisMulti {
  get(key: string): IoredisMulti;
  pttl(key: string): IoredisMulti;
  exec(): Promise<Array<[error: Error | null, result: unknown]> | null>;
}

export function ioredisL2Client(client: {
  multi(): IoredisMulti;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, nx: "NX"): Promise<unknown>;
  set(key: string, value: string, px: "PX", ms: number): Promise<unknown>;
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}): L2Client {
  return {
    async getWithTtl(key) {
      const replies = await client.multi().get(key).pttl(key).exec();
      if (replies === null) throw new Error("MULTI was aborted"); // only after a WATCH; kept as a loud failure
      const [[getError, value], [ttlError, pttl]] = replies as [[Error | null, unknown], [Error | null, unknown]];
      if (getError !== null) throw getError;
      if (ttlError !== null) throw ttlError;
      return [value as string | null, Number(pttl)];
    },
    set: (key, value, ttlMs, onlyIfAbsent) => {
      if (ttlMs === undefined) return onlyIfAbsent ? client.set(key, value, "NX") : client.set(key, value);
      return onlyIfAbsent ? client.set(key, value, "PX", ttlMs, "NX") : client.set(key, value, "PX", ttlMs);
    },
    publish: (channel, message) => client.publish(channel, message),
  };
}

// For an ioredis connection used ONLY for subscribing (e.g. `redis.duplicate()`). ioredis reconnects and
// re-subscribes by itself, but it emits "ready" BEFORE its own SUBSCRIBE has even been sent, so "ready" does not mean
// "listening again". On every "ready" after the first subscribe, this adapter sends SUBSCRIBE itself (subscribing
// twice to a channel is harmless in Redis) and calls onResubscribed only when Redis has confirmed it: from then on
// no message is missed, so clearing L1 at that moment closes the gap.
export function ioredisSubscriber(sub: {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}): L2Subscriber {
  return {
    async subscribe(channel, onMessage, onResubscribed) {
      let subscribed = false;
      const message = (ch: string, text: string) => {
        if (ch === channel) onMessage(text);
      };
      const ready = () => {
        if (!subscribed) return;
        sub.subscribe(channel).then(onResubscribed, () => {}); // a failure here: the next reconnect tries again
      };
      sub.on("message", message);
      sub.on("ready", ready);
      try {
        await sub.subscribe(channel);
      } catch (error) {
        sub.off("message", message);
        sub.off("ready", ready);
        throw error;
      }
      subscribed = true;
      return async () => {
        sub.off("message", message);
        sub.off("ready", ready);
        await sub.unsubscribe(channel);
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Codec: values cross the network as strings.
// ---------------------------------------------------------------------------------------------------------------

export interface Codec<V> {
  encode(value: V): string;
  decode(text: string): V;
}

// The default. JSON inside an envelope {"v": ...}: JSON.stringify(undefined) is not a string at all, and the envelope
// makes a top-level undefined (a "not found" from a loader) survive as `{}` -> undefined. What JSON still loses: a
// Date becomes an ISO string, a Map / Set becomes {}, undefined inside objects disappears, NaN / Infinity become
// null, a class instance becomes a plain object, a BigInt throws (an encode error: not written to Redis). Pass a
// codec if your values hold any of these.
export const jsonCodec: Codec<any> = {
  encode: (value) => JSON.stringify({ v: value }),
  decode: (text) => (JSON.parse(text) as { v?: unknown }).v,
};

// ---------------------------------------------------------------------------------------------------------------
// The two-level cache.
// ---------------------------------------------------------------------------------------------------------------

export type L2Op = "get" | "set" | "delete" | "publish" | "subscribe" | "encode" | "decode" | "message";

// What delete() leaves in Redis for tombstoneMs instead of removing the key (see delete). Readers treat it as a miss.
// A NUL character first: the JSON codec never produces it, and a custom codec producing exactly this is not
// realistic. Exported for tests and for anyone inspecting Redis by hand.
export const TOMBSTONE = "\u0000cache-kit:deleted";

const FAILED: unique symbol = Symbol("failed");

export type TwoLevelEvent =
  // A Redis call failed or timed out, or a value / message could not be (de)coded. The cache carried on without L2.
  | { readonly type: "l2-error"; readonly op: L2Op; readonly key: string | undefined; readonly error: unknown }
  // Another replica's set / delete dropped this key from our L1.
  | { readonly type: "invalidated"; readonly key: string }
  // The subscriber reconnected: messages may have been missed, so L1 was cleared.
  | { readonly type: "resubscribed" };

export interface TwoLevelStats {
  l2Hits: number; // L1 misses answered by Redis (no loader call)
  l2Misses: number; // L1 misses Redis could not answer (key absent): the loader ran
  l2Errors: number; // Redis calls that failed or timed out, and values / messages that could not be (de)coded
  l2Writes: number; // values written to Redis (after a load, or by set)
  // Writes after a load that Redis refused because the key already held something (SET NX): a newer set(), a
  // delete()'s tombstone, or another replica's load got there first.
  l2WritesSkipped: number;
  invalidationsSent: number;
  invalidationsReceived: number; // from other replicas (our own messages are ignored)
  resubscribes: number; // reconnections of the subscriber, each of which cleared L1
}

export interface TwoLevelCacheOptions<V> {
  l1: LruCache<string, V>; // the in-process cache; its ttlMs / staleMs / negativeTtlMs / limits apply as usual
  redis: L2Client;
  // Without one there is no invalidation between replicas: another replica's L1 copy lives until its TTL.
  subscriber?: L2Subscriber;
  // Required, e.g. "myapp:users:". Every Redis key is prefix + key. Keeps two caches (or two apps) on one Redis apart.
  prefix: string;
  channel?: string; // the invalidation channel; default prefix + "invalidate" (channels and keys never collide in Redis)
  codec?: Codec<V>; // default jsonCodec (see what it loses)
  // Every Redis call gives up after this long and the cache carries on without L2 (a load goes to the loader).
  // Default 250: far above a healthy Redis round trip (well under a millisecond in the same data centre), small next
  // to the request timeouts it protects. Set ioredis's enableOfflineQueue: false too, so commands fail at once while
  // disconnected instead of queueing until this timeout.
  l2TimeoutMs?: number;
  // How long delete() keeps a tombstone in Redis, during which no load can write the key back (see delete). Must be
  // longer than your slowest load (its timeout); default 10 000. Longer only means that, for that long after a
  // delete, Redis holds nothing for the key and each replica loads it once into its own L1.
  tombstoneMs?: number;
  onEvent?: (event: TwoLevelEvent) => void;
}

// L1 = the in-process LruCache, L2 = Redis shared by every replica. getOrLoad: L1 -> L2 -> loader, then the value is
// written back to both. set / delete write Redis and PUBLISH an invalidation that makes the other replicas drop
// their L1 copy. Redis failing never fails a read: it degrades to L1 + loader (each Redis call bounded by
// l2TimeoutMs).
//
// Writes after a LOAD use SET NX (only if the key is absent), explicit writes overwrite. Why: a load on replica B
// reads the DB, then replica A updates the row and calls set(); B's write of the OLD value travels on B's own
// connection and can reach Redis AFTER A's set (found by the real-Redis test: Redis then served the old value to
// every replica for a whole TTL). With NX, B's late write is refused because A's value is there. delete() writes a
// tombstone instead of DEL for the same reason: a late NX write finds the tombstone and is refused too. See the
// README for the windows that remain.
export class TwoLevelCache<V> {
  readonly l1: LruCache<string, V>;
  // A random id per instance: every replica also receives its OWN messages, and must not drop the value it just set.
  readonly id = randomUUID();
  // Resolves true once subscribed, false without a subscriber or if subscribing failed (an l2-error event). Never
  // rejects.
  readonly ready: Promise<boolean>;
  private readonly redis: L2Client;
  private readonly prefix: string;
  private readonly channel: string;
  private readonly codec: Codec<V>;
  private readonly timeoutMs: number;
  private readonly tombstoneMs: number;
  private readonly onEvent: ((event: TwoLevelEvent) => void) | undefined;
  private readonly pending = new Set<Promise<void>>(); // L2 writes not awaited by their caller (after a load)
  private unsubscribe: (() => Promise<void>) | undefined;
  private readonly counters: TwoLevelStats = {
    l2Hits: 0, l2Misses: 0, l2Errors: 0, l2Writes: 0, l2WritesSkipped: 0, invalidationsSent: 0, invalidationsReceived: 0,
    resubscribes: 0,
  };

  constructor(options: TwoLevelCacheOptions<V>) {
    if (typeof options.prefix !== "string" || options.prefix === "") throw new TypeError("prefix must be a non-empty string");
    const timeout = options.l2TimeoutMs ?? 250;
    if (!(Number.isFinite(timeout) && timeout > 0)) throw new RangeError("l2TimeoutMs must be a finite number > 0");
    const tombstone = options.tombstoneMs ?? 10_000;
    if (!(Number.isFinite(tombstone) && tombstone > 0)) throw new RangeError("tombstoneMs must be a finite number > 0");
    this.tombstoneMs = tombstone;
    this.l1 = options.l1;
    this.redis = options.redis;
    this.prefix = options.prefix;
    this.channel = options.channel ?? `${options.prefix}invalidate`;
    this.codec = options.codec ?? (jsonCodec as Codec<V>);
    this.timeoutMs = timeout;
    this.onEvent = options.onEvent;
    const sub = options.subscriber;
    this.ready = sub === undefined
      ? Promise.resolve(false)
      : sub.subscribe(this.channel, (m) => this.onMessage(m), () => this.onResubscribed()).then(
          (unsubscribe) => ((this.unsubscribe = unsubscribe), true),
          (error: unknown) => (this.fail("subscribe", undefined, error), false),
        );
  }

  stats(): TwoLevelStats {
    return { ...this.counters };
  }

  // L1 (with its single flight, stale-while-revalidate and negative caching) -> Redis -> loader. The Redis read runs
  // INSIDE the L1 load, so 100 concurrent misses on one replica cost one Redis read, not 100.
  getOrLoad(key: string, loader: Loader<V>, options: LoadOptions = {}): Promise<V> {
    return this.l1.getOrLoad(key, (signal, context) => this.loadThrough(key, loader, signal, context), options);
  }

  // Sets L1 and Redis, then tells the other replicas. Resolves true when Redis confirmed both the write and the
  // publish; false when Redis failed (an l2-error event): then L1 here is updated, but other replicas may serve the
  // OLD value from their L1 and from Redis until those TTLs end. Throws (before touching Redis) on invalid options.
  async set(key: string, value: V, options: SetOptions = {}): Promise<boolean> {
    this.l1.set(key, value, options);
    const text = this.encode(key, value);
    const ttl = redisTtl(options.ttlMs ?? this.l1.defaultTtlMs);
    const stored = text !== undefined && (await this.call("set", key, () => this.redis.set(this.prefix + key, text, ttl, false))) !== FAILED;
    if (stored) this.counters.l2Writes++;
    const told = await this.invalidateOthers(key);
    return stored && told;
  }

  // Removes the key here, replaces it in Redis by a tombstone for tombstoneMs (a miss for every reader, and a load
  // that read the DB before the delete cannot write the old value back: its SET NX is refused), then tells the other
  // replicas. Resolves true when Redis confirmed both; on false the same weakness as set() applies (and Redis may
  // still hold the old value until its TTL).
  async delete(key: string): Promise<boolean> {
    this.l1.delete(key);
    const removed = (await this.call("delete", key, () => this.redis.set(this.prefix + key, TOMBSTONE, this.tombstoneMs, false))) !== FAILED;
    const told = await this.invalidateOthers(key);
    return removed && told;
  }

  // Waits for the background Redis writes started by loads (each bounded by l2TimeoutMs). For tests and shutdown.
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // Waits for pending writes and unsubscribes. Does NOT close the Redis clients (you passed them in, you own them)
  // nor the L1 (its sweep timer is unref'd anyway; call l1.close() if you set one).
  async close(): Promise<void> {
    await this.flush();
    await this.ready;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (unsubscribe !== undefined) await this.call("subscribe", undefined, unsubscribe);
  }

  private async loadThrough(key: string, loader: Loader<V>, signal: AbortSignal, context: LoadContext): Promise<V> {
    const read = await this.readL2(key);
    if (typeof read === "object") {
      this.counters.l2Hits++;
      // The L1 copy must not outlive the Redis copy (or every replica would keep its own value after Redis dropped
      // it), nor live longer than this call asked for.
      context.ttlMs = Math.min(read.ttlMs, context.ttlMs ?? Infinity);
      return read.value;
    }
    signal.throwIfAborted(); // every caller left while Redis was asked: do not start the loader for nobody
    const value = await loader(signal, context);
    // Not after a delete / set / invalidation of this key during the load: the value may be older than the change,
    // and Redis would hand it to every replica (the in-process twin of this check is in LruCache.startLoad). A value
    // Redis holds but we could not decode is overwritten; anything else only if the key is still absent (see above).
    if (context.isCurrent()) this.writeBehind(key, value, this.l1.loadedTtl(value, context.ttlMs), read !== "corrupt");
    return value;
  }

  // A hit, "corrupt" (a value we cannot decode), or undefined (absent, a tombstone, or Redis failed).
  private async readL2(key: string): Promise<{ value: V; ttlMs: number } | "corrupt" | undefined> {
    let reply: [string | null, number];
    try {
      reply = await this.withTimeout(this.redis.getWithTtl(this.prefix + key));
    } catch (error) {
      this.fail("get", key, error);
      return undefined;
    }
    const [text, pttl] = reply;
    // pttl -2 = gone, 0 = expires within the millisecond: both a miss. -1 = no expiry.
    if (text === null || text === TOMBSTONE || (pttl !== -1 && !(pttl > 0))) {
      this.counters.l2Misses++;
      return undefined;
    }
    let value: V;
    try {
      value = this.codec.decode(text);
    } catch (error) {
      // A corrupt value, or one written by another version of the app with another codec. Treated as a miss: the
      // loader runs and its value overwrites the bad one.
      this.fail("decode", key, error);
      return "corrupt";
    }
    return { value, ttlMs: pttl === -1 ? Infinity : pttl };
  }

  // Not awaited by the load: the callers already have their value and must not wait on Redis. Tracked for flush().
  private writeBehind(key: string, value: V, ttlMs: number | undefined, onlyIfAbsent: boolean): void {
    const text = this.encode(key, value);
    if (text === undefined) return;
    const write = this.call("set", key, () => this.redis.set(this.prefix + key, text, redisTtl(ttlMs), onlyIfAbsent)).then((reply) => {
      if (reply === null) this.counters.l2WritesSkipped++; // NX: the key held something newer
      else if (reply !== FAILED) this.counters.l2Writes++;
      this.pending.delete(write);
    });
    this.pending.add(write);
  }

  private async invalidateOthers(key: string): Promise<boolean> {
    const ok = (await this.call("publish", key, () => this.redis.publish(this.channel, JSON.stringify([this.id, key])))) !== FAILED;
    if (ok) this.counters.invalidationsSent++;
    return ok;
  }

  private onMessage(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      this.fail("message", undefined, new Error(`malformed invalidation message: ${message.slice(0, 200)}`));
      return;
    }
    const [from, key] = parsed as [string, string];
    if (from === this.id) return; // our own set / delete: already applied here
    // delete() also detaches a load running for the key, so it writes neither L1 nor (see loadThrough) Redis.
    this.l1.delete(key);
    this.counters.invalidationsReceived++;
    this.emit({ type: "invalidated", key });
  }

  // Messages sent while we were disconnected are lost, so any L1 entry may be stale: drop them all. L1 refills from
  // Redis (cheap), not from the loader. clear() also detaches every running load, so none writes a value it read
  // before the reconnect.
  private onResubscribed(): void {
    this.l1.clear();
    this.counters.resubscribes++;
    this.emit({ type: "resubscribed" });
  }

  private encode(key: string, value: V): string | undefined {
    try {
      const text = this.codec.encode(value);
      if (typeof text !== "string") throw new TypeError(`codec.encode returned ${typeof text}, not a string`);
      return text;
    } catch (error) {
      this.fail("encode", key, error);
      return undefined;
    }
  }

  // Runs one Redis call with the timeout; its reply, or FAILED (and an l2-error event). Never throws.
  private async call(op: L2Op, key: string | undefined, fn: () => Promise<unknown>): Promise<unknown> {
    try {
      return await this.withTimeout(fn());
    } catch (error) {
      this.fail(op, key, error);
      return FAILED;
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {}); // if the timeout wins, a later rejection of the call must not be unhandled
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis did not answer within ${this.timeoutMs} ms`)), this.timeoutMs);
      timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private fail(op: L2Op, key: string | undefined, error: unknown): void {
    this.counters.l2Errors++;
    this.emit({ type: "l2-error", op, key, error });
  }

  private emit(event: TwoLevelEvent): void {
    if (this.onEvent === undefined) return;
    try {
      this.onEvent(event);
    } catch {
      // ignored: telemetry must never change what the caller gets (as in events.ts)
    }
  }
}

// Redis wants whole milliseconds. Rounded UP so a 0.5 ms TTL does not become "PX 0" (an error); Infinity = no expiry.
function redisTtl(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined || ttlMs === Infinity) return undefined;
  return Math.max(1, Math.ceil(ttlMs));
}
