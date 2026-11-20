import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Balancer } from "./balancer.js";
import type { Lease, Strategy } from "./balancer.js";
import { buildClientHeaders, buildUpstreamHeaders, hasLoop } from "./headers.js";

export interface RequestLog {
  method: string;
  url: string;
  status: number;
  /** true when the client went away, or the upstream broke, before the response was complete */
  aborted: boolean;
  ms: number;
  /** "host:port" of the upstream that served the request (absent when none was chosen, e.g. a 508) */
  upstream?: string;
}

export interface ProxyOptions {
  /** where requests go: one URL or several. Plain http only, and no path prefix ("http://127.0.0.1:3000"). */
  upstream?: URL | URL[];
  /** how to choose between several upstreams. Default "round-robin". */
  strategy?: Strategy;
  /** supply your own Balancer instead of upstream/strategy (lets tests and callers inspect the counters). */
  balancer?: Balancer;
  /** true = keep and extend an X-Forwarded-For sent by a proxy we trust (Caddy). false = overwrite it. */
  trustForwarded?: boolean;
  /** idle timeout against the upstream (connecting, waiting for headers, and between body chunks). Default 30000. */
  upstreamTimeoutMs?: number;
  /** max sockets kept open to the upstream. Default 256. */
  maxUpstreamSockets?: number;
  log?: (entry: RequestLog) => void;
}

class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`upstream idle for more than ${ms} ms`);
    this.name = "UpstreamTimeoutError";
  }
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createProxy(options: ProxyOptions): http.Server {
  let balancer = options.balancer;
  if (!balancer) {
    if (!options.upstream) throw new Error("upstream (or balancer) is required");
    const urls = Array.isArray(options.upstream) ? options.upstream : [options.upstream];
    for (const upstream of urls) {
      if (upstream.protocol !== "http:") throw new Error("only http:// upstreams are supported");
      if (upstream.pathname !== "/" || upstream.search) throw new Error("upstream must not contain a path or query");
    }
    balancer = new Balancer(urls, options.strategy);
  }
  const lb = balancer;

  const trustForwarded = options.trustForwarded ?? false;
  const timeoutMs = options.upstreamTimeoutMs ?? 30_000;
  // Reusing TCP connections to the upstream saves a handshake per request.
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.maxUpstreamSockets ?? 256 });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const started = Date.now();
    let aborted = false;
    let lease: Lease | undefined;
    res.on("close", () => {
      lease?.release(); // every path ends here (success, error, client abort), so the counter cannot leak
      options.log?.({
        method: req.method ?? "?",
        url: req.url ?? "?",
        status: res.statusCode,
        aborted: aborted || !res.writableFinished,
        ms: Date.now() - started,
        upstream: lease?.target.url.host,
      });
    });

    if (hasLoop(req.headers)) {
      // We are (indirectly) our own upstream. Without this the request would circle until sockets run out.
      plain(res, 508, "Loop Detected");
      req.resume();
      return;
    }

    lease = lb.acquire();
    const target = lease.target.url;
    const up = http.request({
      agent,
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url, // origin-form: path + query, exactly as the client sent it
      headers: buildUpstreamHeaders(
        req.headers,
        { remoteAddress: req.socket.remoteAddress, host: req.headers.host },
        { trustForwarded },
      ) as OutgoingHttpHeaders,
      timeout: timeoutMs,
    });

    up.on("timeout", () => up.destroy(new UpstreamTimeoutError(timeoutMs)));

    up.on("response", (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, buildClientHeaders(upRes.headers) as OutgoingHttpHeaders);
      upRes.pipe(res); // streams: the body is never held in memory
      // pipe() does not propagate a broken upstream: if the body is cut short, drop the client
      // connection too so the client sees a failure instead of a silently truncated "success".
      upRes.on("close", () => {
        if (!upRes.complete) {
          aborted = true;
          res.destroy();
        }
      });
    });

    up.on("error", (err) => {
      if (res.destroyed) return; // client already gone, nothing to tell it
      if (res.headersSent) {
        aborted = true;
        res.destroy(); // too late for a clean 5xx
        return;
      }
      if (err instanceof UpstreamTimeoutError) plain(res, 504, "Gateway Timeout");
      else plain(res, 502, "Bad Gateway");
      req.resume(); // discard the rest of the client body so the connection stays usable
    });

    // Client hung up (or finished): if the response is not finished, stop the upstream work too.
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });

    req.pipe(up);
  }

  const server = http.createServer(handle);
  server.on("close", () => agent.destroy());
  return server;
}
