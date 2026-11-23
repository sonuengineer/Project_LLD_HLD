// Express adapter. Written against Node's http types (Express's req/res extend them), so it works with Express 4
// and 5 without importing Express at runtime (tested with 4.21.2).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RateLimiter } from "../limiter.js";
import { keyByIp, setHeaders, TOO_MANY_REQUESTS_BODY, type KeyFn } from "./http.js";

type Next = (error?: unknown) => void;

export interface RateLimitMiddlewareOptions {
  // Who is being limited. Default keyByIp() (socket address; X-Forwarded-For ignored -- set trustedProxies behind
  // a proxy). Return undefined to NOT limit this request with this limiter (e.g. a per-user limit and no user).
  key?: KeyFn;
  cost?: (req: IncomingMessage) => number; // default 1
  headers?: boolean; // send RateLimit-* headers on every response, default true
}

// app.use("/api", rateLimit(apiLimiter, { key: keyByIp({ trustedProxies: 1 }) }));
// app.post("/login", rateLimit(loginLimiter, { key: (req) => "email:" + req.body?.email?.toLowerCase() }), login);
//
// Denied: 429 with Retry-After and a generic JSON body; the route does not run.
// A store error (Redis down) goes to next(err) -- the app's error handler decides (fail-open / fail-closed per limit
// is stage 3).
export function rateLimit(limiter: RateLimiter, options: RateLimitMiddlewareOptions = {}) {
  const keyFn = options.key ?? keyByIp();
  const sendHeaders = options.headers ?? true;
  return function rateLimitMiddleware(req: IncomingMessage, res: ServerResponse, next: Next): void {
    void (async () => {
      const key = await keyFn(req);
      if (key === undefined) return next();
      const decision = await limiter.consume(key, options.cost?.(req) ?? 1);
      if (sendHeaders || !decision.allowed) setHeaders(res, decision);
      if (decision.allowed) return next();
      res.statusCode = 429;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(TOO_MANY_REQUESTS_BODY));
    })().catch(next);
  };
}

export { clientIp, ipKey, keyByIp, rateLimitHeaders, type KeyFn } from "./http.js";
