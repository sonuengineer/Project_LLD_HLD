// Express adapter. Written against Node's http types (Express's req/res extend them), so it works with Express 4
// and 5 without importing Express at runtime (tested with 4.21.2).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RateLimiter } from "../limiter.js";
import { RateLimitError, type Decision } from "../types.js";
import {
  keyByIp,
  setHeaders,
  STORE_UNAVAILABLE_BODY,
  STORE_UNAVAILABLE_RETRY_AFTER_S,
  TOO_MANY_REQUESTS_BODY,
  type KeyFn,
  type OnStoreError,
} from "./http.js";

type Next = (error?: unknown) => void;

export interface RateLimitMiddlewareOptions {
  // Who is being limited. Default keyByIp() (socket address; X-Forwarded-For ignored -- set trustedProxies behind
  // a proxy). Return undefined to NOT limit this request with this limiter (e.g. a per-user limit and no user).
  key?: KeyFn;
  cost?: (req: IncomingMessage) => number; // default 1
  headers?: boolean; // send RateLimit-* headers on every response, default true
  onStoreError?: OnStoreError; // see adapters/http.ts; default "error"
}

// app.use("/api", rateLimit(apiLimiter, { key: keyByIp({ trustedProxies: 1 }), onStoreError: "allow" }));
// app.post("/login", rateLimit(loginLimiter, { key: ..., onStoreError: "deny" }), login);
//
// Denied: 429 with Retry-After and a generic JSON body; the route does not run.
export function rateLimit(limiter: RateLimiter, options: RateLimitMiddlewareOptions = {}) {
  const keyFn = options.key ?? keyByIp();
  const sendHeaders = options.headers ?? true;
  const onStoreError = options.onStoreError ?? "error";
  return function rateLimitMiddleware(req: IncomingMessage, res: ServerResponse, next: Next): void {
    void (async () => {
      const key = await keyFn(req);
      if (key === undefined) return next();
      // Computed OUTSIDE the try: a throwing cost function is a bug in the app, never a store error to fail open on.
      const cost = options.cost?.(req) ?? 1;
      let decision: Decision;
      try {
        decision = await limiter.consume(key, cost);
      } catch (error) {
        if (error instanceof RateLimitError || onStoreError === "error") throw error;
        if (onStoreError === "allow") return next();
        res.statusCode = 503;
        res.setHeader("retry-after", String(STORE_UNAVAILABLE_RETRY_AFTER_S));
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(STORE_UNAVAILABLE_BODY));
        return;
      }
      if (sendHeaders || !decision.allowed) setHeaders(res, decision);
      if (decision.allowed) return next();
      res.statusCode = 429;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(TOO_MANY_REQUESTS_BODY));
    })().catch(next);
  };
}

export { clientIp, ipKey, keyByIp, rateLimitHeaders, type KeyFn, type OnStoreError } from "./http.js";
