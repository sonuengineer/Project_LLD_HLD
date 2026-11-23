// Express adapter. Written against Node's own http types (IncomingMessage / ServerResponse), which Express's req and
// res extend, so it works with Express 4 and 5 without importing Express at runtime.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Bulkhead } from "../bulkhead.js";
import { BulkheadRejectedError, ClientClosedError } from "../errors.js";
import { mapResilienceError } from "./http-status.js";

type Next = (error?: unknown) => void;

const signals = new WeakMap<ServerResponse, AbortSignal>();

// An AbortSignal that is aborted (reason: ClientClosedError) when the client disconnects before the response is
// finished. Pass it to policy.execute(op, signal) so a call for a client that is gone stops: no more retries, no
// more waiting, the outbound request is cancelled. One signal per response (repeated calls return the same one).
//
// Listens on the RESPONSE's 'close' (not the request's: since Node 16 the request emits 'close' as soon as its body
// has been read, which is not a disconnect).
export function requestSignal(_req: IncomingMessage, res: ServerResponse): AbortSignal {
  const existing = signals.get(res);
  if (existing !== undefined) return existing;
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort(new ClientClosedError());
  });
  signals.set(res, controller.signal);
  return controller.signal;
}

// Error middleware: turns BrokenCircuitError / BulkheadRejectedError / TimeoutError into 503 / 503 / 504 with a
// generic JSON body (see http-status.ts); anything else goes to the next error handler untouched. Register it
// after your routes: app.use(resilienceErrorHandler()).
export function resilienceErrorHandler() {
  return function resilienceErrors(error: unknown, _req: IncomingMessage, res: ServerResponse, next: Next): void {
    const mapped = mapResilienceError(error);
    if (mapped === undefined || res.headersSent) {
      next(error);
      return;
    }
    res.statusCode = mapped.status;
    for (const [name, value] of Object.entries(mapped.headers)) res.setHeader(name, value);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(mapped.body));
  };
}

// Load shedding for INCOMING requests: at most bulkhead.maxConcurrent requests are handled at once (plus its queue);
// the rest get 503 at once instead of piling up and making every request slow. A request holds its slot until its
// response is finished or the connection closes. A queued request whose client disconnects leaves the queue.
export function loadShedding(bulkhead: Bulkhead) {
  return function shedLoad(req: IncomingMessage, res: ServerResponse, next: Next): void {
    bulkhead
      .execute(
        () =>
          new Promise<void>((resolve) => {
            res.once("close", () => resolve());
            next();
          }),
        requestSignal(req, res),
      )
      .catch((error: unknown) => {
        if (error instanceof BulkheadRejectedError) {
          resilienceErrorHandler()(error, req, res, next);
        }
        // ClientClosedError while queued: the client is gone, nothing to answer.
      });
  };
}
