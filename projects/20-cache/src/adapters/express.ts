// Express helper (cache-kit/express). Written against Node's http types, so it works with Express 4 and 5 without
// importing Express at runtime (tested with 4.21.2).
import type { IncomingMessage, ServerResponse } from "node:http";
import { isNotFound, loadForRequest, NOT_FOUND_BODY, requestSignal, type CachedResponseOptions, type Loadable } from "./http.js";

type Next = (error?: unknown) => void;

// A GET handler whose JSON result is cached:
//   app.get("/products/:id", cachedJson(cache, { key: (req) => `product:${req.params.id}`, ttlMs: 60_000 },
//     (req, signal) => db.products.find(req.params.id, { signal })));
//
// Caches the DATA, not the HTTP bytes: the producer returns a value, the helper sends it as JSON with
// X-Cache: hit | miss | bypass. A value that means "not found" (default null / undefined) is answered with 404 --
// and, being a value, it is cached like any other (cache-kit's negative caching applies if the cache has it).
// A producer error is NOT cached (cache-kit never caches errors) and goes to next(err).
// If the client disconnects, this request stops waiting; the shared load is aborted only when every request
// waiting for it has gone. Nothing is sent to a client that has gone.
export function cachedJson<V, Req extends IncomingMessage = IncomingMessage>(
  cache: Loadable<V>,
  options: CachedResponseOptions<V>,
  produce: (req: Req, signal: AbortSignal) => Promise<V> | V,
) {
  const notFound = options.notFound ?? isNotFound;
  return function cachedJsonHandler(req: Req, res: ServerResponse, next: Next): void {
    const signal = requestSignal(res);
    loadForRequest(cache, options, req, signal, (s) => produce(req, s))
      .then(({ value, status }) => {
        if (res.writableEnded || res.destroyed) return;
        const missing = notFound(value);
        res.statusCode = missing ? 404 : 200;
        res.setHeader("x-cache", status);
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(missing ? NOT_FOUND_BODY : value));
      })
      .catch((error: unknown) => {
        if (signal.aborted) return; // the client is gone: nobody to answer
        next(error);
      });
  };
}

export { requestSignal, type CachedResponseOptions, type CacheKeyFn, type CacheStatus, type Loadable } from "./http.js";
