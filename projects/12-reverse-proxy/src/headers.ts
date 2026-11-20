import type { IncomingHttpHeaders } from "node:http";

/**
 * Hop-by-hop headers describe ONE TCP connection, not the message, so a proxy must not
 * forward them (RFC 9110 section 7.6.1). Anything named inside the Connection header is
 * hop-by-hop too, whatever its name.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Our token in the Via header. Seeing it on an incoming request means the request already passed through us. */
export const VIA_TOKEN = "h11-proxy";
export const VIA_VALUE = `1.1 ${VIA_TOKEN}`;

export function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = new Set<string>();
  const connection = headers.connection;
  if (connection) {
    for (const token of connection.split(",")) named.add(token.trim().toLowerCase());
  }
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || named.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** "::ffff:10.0.0.1" (IPv4 seen on a dual-stack socket) -> "10.0.0.1". */
export function normalizeIp(address: string | undefined): string {
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export interface ForwardInfo {
  /** socket peer address of the client that connected to US */
  remoteAddress: string | undefined;
  /** original Host header of the incoming request */
  host: string | undefined;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Builds the headers sent to the upstream.
 *
 * X-Forwarded-For: a client controls this header, so by default we IGNORE what it sent and
 * set the real socket peer. Behind another trusted proxy (for example Caddy) pass
 * trustForwarded=true and we append instead, keeping the chain.
 */
export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  info: ForwardInfo,
  opts: { trustForwarded: boolean },
): IncomingHttpHeaders {
  const out = stripHopByHop(incoming);
  const peer = normalizeIp(info.remoteAddress);
  const priorFor = first(incoming["x-forwarded-for"]);

  if (opts.trustForwarded && priorFor) {
    out["x-forwarded-for"] = `${priorFor}, ${peer}`;
    out["x-forwarded-proto"] = first(incoming["x-forwarded-proto"]) ?? "http";
    out["x-forwarded-host"] = first(incoming["x-forwarded-host"]) ?? info.host;
  } else {
    out["x-forwarded-for"] = peer;
    out["x-forwarded-proto"] = "http";
    out["x-forwarded-host"] = info.host;
  }
  if (out["x-forwarded-host"] === undefined) delete out["x-forwarded-host"];

  // RFC 9110: a proxy appends itself to Via on the way through.
  const via = first(incoming.via);
  out.via = via ? `${via}, ${VIA_VALUE}` : VIA_VALUE;

  // Transfer-Encoding is hop-by-hop and was stripped above. If the client sent a chunked body
  // (no Content-Length), the body still has no length, so re-frame it as chunked for the upstream.
  if (/\bchunked\b/i.test(first(incoming["transfer-encoding"]) ?? "")) {
    out["transfer-encoding"] = "chunked";
  }
  return out;
}

export function buildClientHeaders(upstream: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = stripHopByHop(upstream);
  const via = first(upstream.via);
  out.via = via ? `${via}, ${VIA_VALUE}` : VIA_VALUE;
  return out;
}

export function hasLoop(incoming: IncomingHttpHeaders): boolean {
  const via = incoming.via;
  if (!via) return false;
  const joined = Array.isArray(via) ? via.join(",") : via;
  return joined.split(",").some((hop) => hop.trim().split(/\s+/)[1] === VIA_TOKEN);
}
