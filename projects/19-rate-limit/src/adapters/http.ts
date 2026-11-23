// Shared by the Express and NestJS adapters: client identification, response headers, the 429 body.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Decision } from "../types.js";

// ---- Client IP ----
//
// X-Forwarded-For is written by EVERY hop, including the client itself: a client can send
// "X-Forwarded-For: 1.2.3.4" and, if we trusted the left-most entry, get a fresh limit per request. Only the entries
// added by proxies WE run can be trusted, and each proxy appends the address it saw on the right. So with
// `trustedProxies` = how many of our proxies sit in front of the app:
//   0 (default) -> the socket address; X-Forwarded-For is ignored completely
//   1 (one nginx / load balancer) -> the right-most X-Forwarded-For entry
//   n -> the n-th entry from the right
// If the header has fewer entries than expected, the left-most one is used (what Express's `trust proxy` = n does).
export function clientIp(req: IncomingMessage, trustedProxies = 0): string | undefined {
  if (!Number.isSafeInteger(trustedProxies) || trustedProxies < 0) throw new RangeError("trustedProxies must be an integer >= 0");
  const socketAddr = req.socket?.remoteAddress;
  if (trustedProxies === 0) return socketAddr;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  const hops = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const chain = socketAddr === undefined ? hops : [...hops, socketAddr];
  return chain[Math.max(0, chain.length - 1 - trustedProxies)];
}

// A rate-limit key for an address:
//   IPv4 and IPv4-mapped IPv6 (::ffff:1.2.3.4) -> "ip:1.2.3.4"
//   IPv6 -> its /64 prefix, "ip6:2001:db8:1:2::/64". One subscriber usually gets a whole /64 and can use any of its
//           2^64 addresses; limiting per full address would give them a fresh limit per address.
//   anything else (not an IP) -> undefined (the request is not limited by IP; see keyByIp's `fallback`).
export function ipKey(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  let a = address.trim();
  if (a.toLowerCase().startsWith("::ffff:") && isIP(a.slice(7)) === 4) a = a.slice(7);
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone); // fe80::1%eth0
  const v = isIP(a);
  if (v === 4) return `ip:${a}`;
  if (v === 6) return `ip6:${expandIpv6(a).slice(0, 4).join(":")}::/64`;
  return undefined;
}

function expandIpv6(a: string): string[] {
  // An embedded IPv4 tail (::1.2.3.4) becomes two hextets.
  let s = a.toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ":" + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((h) => h.replace(/^0+(?=.)/, ""));
}

export type KeyFn = (req: IncomingMessage) => string | undefined | Promise<string | undefined>;

// The usual key: the client's IP (see clientIp / ipKey).
export function keyByIp(options: { trustedProxies?: number } = {}): KeyFn {
  return (req) => ipKey(clientIp(req, options.trustedProxies ?? 0));
}

// ---- Response ----

// Headers (the IETF "RateLimit header fields" draft names most libraries send):
//   RateLimit-Limit      the limit
//   RateLimit-Remaining  units left
//   RateLimit-Reset      seconds until full again (token bucket) / until the window ends (sliding window)
//   Retry-After          on a 429 only: seconds until this request would be allowed (at least 1)
export function rateLimitHeaders(d: Decision): Record<string, string> {
  const headers: Record<string, string> = {
    "ratelimit-limit": String(d.limit),
    "ratelimit-remaining": String(d.remaining),
    "ratelimit-reset": String(Math.ceil(d.resetMs / 1000)),
  };
  if (!d.allowed) headers["retry-after"] = String(Math.max(1, Math.ceil(d.retryAfterMs / 1000)));
  return headers;
}

export function setHeaders(res: ServerResponse, d: Decision): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(rateLimitHeaders(d))) res.setHeader(k, v);
}

export const TOO_MANY_REQUESTS_BODY = { error: "rate_limited", message: "Too many requests. Try again later." } as const;

// ---- When the store fails (Redis down, timeout, circuit open, no fallback) ----
//   "error" (default) -> the framework's error handling (Express next(err), Nest exception layer)
//   "allow"           -> FAIL OPEN: the request goes through unlimited. For limits that protect capacity, where
//                        refusing everyone is worse than briefly not limiting (a general API limit).
//   "deny"            -> FAIL CLOSED: 503 + Retry-After. For limits that protect SECURITY (login, OTP, password
//                        reset): an attacker must not get unlimited guesses because Redis is down. 503, not 429:
//                        the server has the problem, not the client.
// A RateLimitError (bad key / cost -- a bug) is never covered by this: it always goes to error handling.
export type OnStoreError = "error" | "allow" | "deny";
export const STORE_UNAVAILABLE_RETRY_AFTER_S = 5;
export const STORE_UNAVAILABLE_BODY = { error: "rate_limit_unavailable", message: "Please try again shortly." } as const;
