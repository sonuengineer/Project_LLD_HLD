// One event type for everything the cache does on its own (evictions, loads), so ONE handler can feed logs and
// metrics:  onEvent: (e) => metrics.inc(`cache_${e.type}`, { reason: "reason" in e ? e.reason : "" })
// Hits and misses are NOT events (they happen on every call); read them from `stats()`.
// A handler that throws is ignored: telemetry must never change what the caller gets.

export type EvictionReason = "size" | "weight" | "expired";

export type CacheEvent<K> =
  | { readonly type: "evict"; readonly key: K; readonly reason: EvictionReason }
  // set() / a load produced a value heavier than maxWeight on its own: not stored (and an older value for the key is
  // gone, see LruCache.set).
  | { readonly type: "reject"; readonly key: K; readonly weight: number }
  | { readonly type: "load"; readonly key: K }
  | { readonly type: "load-error"; readonly key: K; readonly error: unknown }
  // Every caller waiting for this load aborted, so the load's signal was aborted.
  | { readonly type: "load-abort"; readonly key: K };

export type CacheEventHandler<K> = (event: CacheEvent<K>) => void;

export function emit<K>(handler: CacheEventHandler<K> | undefined, event: CacheEvent<K>): void {
  if (handler === undefined) return;
  try {
    handler(event);
  } catch {
    // ignored on purpose, see above
  }
}
