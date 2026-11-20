import type http from "node:http";

export interface ShutdownOptions {
  /** how often idle keep-alive connections are closed while draining. Default 100 ms. */
  sweepMs?: number;
  /** give up waiting for in-flight requests after this long. Default 10000 ms. */
  forceMs?: number;
}

/**
 * Stop accepting new connections, let in-flight requests finish, and resolve when the server is closed.
 *
 * Resolves "closed" when everything drained, or "forced" if requests were still running after `forceMs`
 * (the caller decides what to do then; the CLI exits with code 1).
 *
 * Why the sweep: server.close() only closes connections that are idle AT THE MOMENT it is called.
 * A connection that is busy now becomes an idle keep-alive connection as soon as its response is
 * finished, and server.close() would then wait for the CLIENT to hang up (seconds). So we keep
 * closing idle connections until the server is closed.
 */
export function gracefulShutdown(server: http.Server, options: ShutdownOptions = {}): Promise<"closed" | "forced"> {
  const sweepMs = options.sweepMs ?? 100;
  const forceMs = options.forceMs ?? 10_000;
  return new Promise((resolve) => {
    let sweep: NodeJS.Timeout | undefined;
    let force: NodeJS.Timeout | undefined;
    const done = (outcome: "closed" | "forced"): void => {
      if (sweep) clearInterval(sweep);
      if (force) clearTimeout(force);
      resolve(outcome);
    };
    server.close(() => done("closed"));
    server.closeIdleConnections();
    sweep = setInterval(() => server.closeIdleConnections(), sweepMs);
    force = setTimeout(() => done("forced"), forceMs);
  });
}
