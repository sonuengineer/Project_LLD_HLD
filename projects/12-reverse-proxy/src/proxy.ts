import http from "node:http";
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Balancer, NoHealthyUpstreamError } from "./balancer.js";
import type { HealthEvent, Lease, Strategy, Target } from "./balancer.js";
import { watchConnect } from "./connect.js";
import { HealthChecker } from "./health.js";
import type { HealthCheckOptions } from "./health.js";
import { buildClientHeaders, buildUpstreamHeaders, hasLoop } from "./headers.js";

export interface RequestLog {
  method: string;
  url: string;
  status: number;
  /** true when the client went away, or the upstream broke, before the response was complete */
  aborted: boolean;
  ms: number;
  /** "host:port" of the LAST upstream tried (absent when none was chosen, e.g. a 508 or a 503) */
  upstream?: string;
  /** how many upstream attempts were made (2 or more means the request was retried) */
  attempts: number;
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
  /** idle timeout against the upstream (waiting for headers, and between body chunks). Default 30000. */
  upstreamTimeoutMs?: number;
  /** give up if the TCP connection to an upstream is not established in time. Default 3000. */
  connectTimeoutMs?: number;
  /** extra attempts for body-less GET/HEAD/OPTIONS that fail before any response byte. Default 1. 0 disables. */
  retries?: number;
  /** passive health: consecutive connection failures before ejecting an upstream. Default 3. (Ignored if you pass a balancer.) */
  ejectAfter?: number;
  /** passive health: how long an ejected upstream is skipped. Default 10000. (Ignored if you pass a balancer.) */
  ejectMs?: number;
  /** active health checks. Off unless given. */
  healthCheck?: HealthCheckOptions;
  /** told whenever an upstream goes up or down (only when the proxy builds the balancer itself). */
  onHealthChange?: (event: HealthEvent) => void;
  /** max sockets kept open to the upstream. Default 256. */
  maxUpstreamSockets?: number;
  log?: (entry: RequestLog) => void;
}

class UpstreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamTimeoutError";
  }
}

class ConnectTimeoutError extends UpstreamTimeoutError {
  constructor(ms: number) {
    super(`no TCP connection within ${ms} ms`);
    this.name = "ConnectTimeoutError";
  }
}

/** Errors that mean "this attempt never reached a working upstream", so trying another one is sensible. */
const RETRYABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"]);

function isRetryable(err: unknown): boolean {
  if (err instanceof ConnectTimeoutError) return true;
  // A response-idle timeout means "slow", not "unreachable". Retrying would double the wait and
  // pile more work onto an upstream that is already struggling, so we do not.
  if (err instanceof UpstreamTimeoutError) return false;
  return RETRYABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "");
}

/**
 * A request can be sent again only if we can produce its bytes again. We stream bodies instead of
 * keeping them, so only requests WITHOUT a body qualify. And only methods that are safe to repeat.
 */
function isReplayable(req: IncomingMessage): boolean {
  const method = req.method ?? "";
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return false;
  if (req.headers["transfer-encoding"]) return false;
  const length = req.headers["content-length"];
  return length === undefined || length === "0";
}

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text), ...extra });
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
    balancer = new Balancer(urls, options.strategy, {
      ejectAfter: options.ejectAfter,
      ejectMs: options.ejectMs,
      onHealthChange: options.onHealthChange,
    });
  }
  const lb = balancer;

  const trustForwarded = options.trustForwarded ?? false;
  const timeoutMs = options.upstreamTimeoutMs ?? 30_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 3000;
  const retries = Math.max(0, options.retries ?? 1);
  // Reusing TCP connections to the upstream saves a handshake per request.
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.maxUpstreamSockets ?? 256 });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const started = Date.now();
    let aborted = false;
    let attempts = 0;
    let lease: Lease | undefined;
    let up: ClientRequest | undefined;

    res.on("close", () => {
      lease?.release(); // every path ends here (success, error, client abort), so the counter cannot leak
      // Client hung up (or finished): if the response is not finished, stop the upstream work too.
      if (!res.writableFinished) up?.destroy();
      options.log?.({
        method: req.method ?? "?",
        url: req.url ?? "?",
        status: res.statusCode,
        aborted: aborted || !res.writableFinished,
        ms: Date.now() - started,
        upstream: lease?.target.url.host,
        attempts,
      });
    });

    if (hasLoop(req.headers)) {
      // We are (indirectly) our own upstream. Without this the request would circle until sockets run out.
      plain(res, 508, "Loop Detected");
      req.resume();
      return;
    }

    const replayable = isReplayable(req);
    const maxAttempts = 1 + (replayable ? retries : 0);
    if (replayable) req.resume(); // no body to forward: just drain

    /** err === undefined means "we never even reached an upstream": nothing was healthy. */
    function sendError(err: unknown): void {
      if (err === undefined) plain(res, 503, "No Healthy Upstream", { "retry-after": "1" });
      else if (err instanceof UpstreamTimeoutError) plain(res, 504, "Gateway Timeout");
      else plain(res, 502, "Bad Gateway");
      if (!replayable) req.resume(); // discard the rest of the client body so the connection stays usable
    }

    function attempt(avoid: Target | undefined, previousError: unknown): void {
      lease?.release(); // give back the slot of a failed earlier attempt before choosing again
      try {
        lease = lb.acquire(avoid);
      } catch (err) {
        if (err instanceof NoHealthyUpstreamError) return sendError(previousError);
        throw err;
      }
      attempts++;
      const target = lease.target;
      const request = http.request({
        agent,
        hostname: target.url.hostname,
        port: target.url.port || 80,
        method: req.method,
        path: req.url, // origin-form: path + query, exactly as the client sent it
        headers: buildUpstreamHeaders(
          req.headers,
          { remoteAddress: req.socket.remoteAddress, host: req.headers.host },
          { trustForwarded },
        ) as OutgoingHttpHeaders,
        timeout: timeoutMs,
      });
      up = request;

      // Count each attempt's failure once, even if both the request and its response report it.
      let failureReported = false;
      const reportFailure = (): void => {
        if (failureReported) return;
        failureReported = true;
        lb.reportFailure(target);
      };

      watchConnect(request, connectTimeoutMs, () => request.destroy(new ConnectTimeoutError(connectTimeoutMs)));
      request.on("timeout", () => request.destroy(new UpstreamTimeoutError(`upstream idle for more than ${timeoutMs} ms`)));

      request.on("response", (upRes) => {
        lb.reportSuccess(target); // it answered, whatever the status: the server is reachable
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, buildClientHeaders(upRes.headers) as OutgoingHttpHeaders);
        upRes.pipe(res); // streams: the body is never held in memory
        // pipe() does not propagate a broken upstream: if the body is cut short, drop the client
        // connection too so the client sees a failure instead of a silently truncated "success".
        upRes.on("close", () => {
          if (!upRes.complete) {
            if (!res.destroyed) reportFailure(); // the upstream broke it (not a client that left)
            aborted = true;
            res.destroy();
          }
        });
      });

      request.on("error", (err) => {
        if (request !== up) return; // an attempt we already moved on from
        if (res.destroyed) return; // client already gone, nothing to tell it and nothing to blame on the upstream
        reportFailure();
        if (res.headersSent) {
          aborted = true;
          res.destroy(); // too late for a clean 5xx, and a retry would repeat bytes the client already got
          return;
        }
        if (attempts < maxAttempts && isRetryable(err)) {
          attempt(target, err);
          return;
        }
        sendError(err);
      });

      if (replayable) request.end();
      else req.pipe(request);
    }

    attempt(undefined, undefined);
  }

  const server = http.createServer(handle);
  const checker = options.healthCheck ? new HealthChecker(lb, options.healthCheck) : undefined;
  server.on("listening", () => checker?.start());
  server.on("close", () => {
    checker?.stop();
    agent.destroy();
  });
  return server;
}
