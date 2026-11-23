import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { requestSignal } from "../src/adapters/express.js";
import { mapResilienceError } from "../src/adapters/http-status.js";
import { BrokenCircuitError, BulkheadRejectedError, ClientClosedError, TimeoutError } from "../src/errors.js";
import { HttpError } from "../src/http.js";

describe("mapResilienceError", () => {
  it.each([
    [0, "1"], // half-open / about to probe: never "Retry-After: 0"
    [1, "1"],
    [999, "1"],
    [1000, "1"],
    [1001, "2"],
    [29_500, "30"],
  ])("open breaker with %s ms left -> 503, Retry-After %s", (ms, header) => {
    const m = mapResilienceError(new BrokenCircuitError("open", ms))!;
    expect(m.status).toBe(503);
    expect(m.headers["retry-after"]).toBe(header);
    expect(m.body.error).toBe("dependency_unavailable");
  });

  it("full bulkhead -> 503 overloaded, Retry-After 1", () => {
    expect(mapResilienceError(new BulkheadRejectedError(2, 0))).toMatchObject({ status: 503, headers: { "retry-after": "1" }, body: { error: "overloaded" } });
  });

  it("timeout -> 504, no Retry-After", () => {
    expect(mapResilienceError(new TimeoutError(100))).toMatchObject({ status: 504, headers: {}, body: { error: "dependency_timeout" } });
  });

  it.each([
    ["an upstream HttpError", new HttpError(401, undefined)],
    ["a plain Error", new Error("x")],
    ["a client disconnect", new ClientClosedError()],
    ["a string", "boom"],
  ])("%s is not mapped (left to the framework)", (_label, error) => {
    expect(mapResilienceError(error)).toBeUndefined();
  });

  it("the body never contains the dependency's own error message", () => {
    const body = JSON.stringify(mapResilienceError(new TimeoutError(1234))!.body);
    expect(body).not.toContain("1234");
  });
});

describe("requestSignal (unit, fake req/res)", () => {
  const fakeRes = () => Object.assign(new EventEmitter(), { writableFinished: false }) as unknown as ServerResponse & { writableFinished: boolean };
  const req = {} as IncomingMessage;

  it("returns the same signal for the same response", () => {
    const res = fakeRes();
    expect(requestSignal(req, res)).toBe(requestSignal(req, res));
    expect(requestSignal(req, fakeRes())).not.toBe(requestSignal(req, res));
  });

  it("aborts with ClientClosedError on close before the response finished; not after it finished", () => {
    const early = fakeRes();
    const s1 = requestSignal(req, early);
    early.emit("close");
    expect(s1.aborted).toBe(true);
    expect(s1.reason).toBeInstanceOf(ClientClosedError);

    const done = fakeRes();
    const s2 = requestSignal(req, done);
    done.writableFinished = true;
    done.emit("close");
    expect(s2.aborted).toBe(false);
  });
});
