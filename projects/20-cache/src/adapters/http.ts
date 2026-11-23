// Shared by the Express and NestJS helpers.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Loader, LoadOptions } from "../cache.js";

// Anything that can load-through: LruCache<string, V> and TwoLevelCache<V> both fit (structural).
export interface Loadable<V> {
  getOrLoad(key: string, loader: Loader<V>, options?: LoadOptions): Promise<V>;
}

// Who / what a cached response is for. MUST include everything the producer reads from the request -- with
// coalescing, only the FIRST request's producer runs and every request with the same key gets its result.
//   per resource:      (req) => `product:${id}`                      (same answer for everyone)
//   per user:          (req) => `cart:${userId(req)}`                (NEVER omit the user for user-specific data)
//   per query string:  (req) => `search:${normalised query}`
// undefined -> do not cache this request (it runs the producer and is answered with X-Cache: bypass).
export type CacheKeyFn = (req: IncomingMessage) => string | undefined | Promise<string | undefined>;

export interface CachedResponseOptions<V> {
  key: CacheKeyFn; // required on purpose: there is no safe default
  ttlMs?: number;
  staleMs?: number;
  // A value that means "not found" -> 404 instead of 200. Default: null or undefined (cache-kit's negative values).
  notFound?: (value: V) => boolean;
}

export type CacheStatus = "hit" | "stale" | "miss" | "bypass";

// An AbortSignal aborted when the client disconnects before the response is finished. Passed to getOrLoad: the
// caller stops waiting, and if EVERY request waiting for the same load has gone, the load itself is aborted.
// Listens on the RESPONSE's close (since Node 16 the request emits close once its body has been read).
export function requestSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort(new Error("client closed the connection"));
  });
  return controller.signal;
}

// Runs one cached request: the producer only on a miss (and only once for concurrent misses of the same key).
// "hit"    = this request did not run the producer: served from the cache, from L2, or from a load another request
//            started.
// "stale"  = served a STALE value at once (stale-while-revalidate) while this request started the background refresh.
//            (The first version reported this as "miss", because the refresh calls the loader synchronously; found
//            by a reviewer while writing the interview bank.)
// "miss"   = this request waited for the producer it ran.
// "bypass" = no key, not cached.
export async function loadForRequest<V>(
  cache: Loadable<V>,
  options: CachedResponseOptions<V>,
  req: IncomingMessage,
  signal: AbortSignal,
  produce: (signal: AbortSignal) => Promise<V> | V,
): Promise<{ value: V; status: CacheStatus }> {
  const key = await options.key(req);
  if (key === undefined) return { value: await produce(signal), status: "bypass" };
  let ran = false;
  let refreshed = false;
  const value = await cache.getOrLoad(
    key,
    (loadSignal, context) => {
      // context is optional in the Loadable shape; LruCache and TwoLevelCache always pass it.
      if (context?.refresh) refreshed = true;
      else ran = true;
      return produce(loadSignal);
    },
    { signal, ttlMs: options.ttlMs, staleMs: options.staleMs },
  );
  return { value, status: ran ? "miss" : refreshed ? "stale" : "hit" };
}

export const isNotFound = (v: unknown): boolean => v === null || v === undefined;
export const NOT_FOUND_BODY = { error: "not_found" } as const;
