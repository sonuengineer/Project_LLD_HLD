import "reflect-metadata";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestSignal, ResilienceExceptionFilter } from "../src/adapters/nestjs.js";
import { CircuitBreaker } from "../src/breaker.js";
import { Bulkhead } from "../src/bulkhead.js";
import { ClientClosedError } from "../src/errors.js";
import { isRetryableHttp } from "../src/http.js";
import { TimeoutPolicy } from "../src/timeout.js";
import { wrap } from "../src/wrap.js";
import { addressOf, eventually, getJson, hang, json, status, upstream, type Upstream } from "./support.js";

// Module-level state the controller uses (Nest DI is not the point of these tests).
let up: Upstream;
let breaker: CircuitBreaker;
let lastSignal: AbortSignal | undefined;
const full = new Bulkhead({ maxConcurrent: 1 });

@Controller()
class ProxyController {
  @Get("proxy")
  async proxy(@RequestSignal() signal: AbortSignal): Promise<unknown> {
    lastSignal = signal;
    return wrap(breaker, new TimeoutPolicy({ ms: 200 })).execute((s) => getJson(up.url, s), signal);
  }

  @Get("full")
  async busy(): Promise<unknown> {
    return full.execute(async () => "never");
  }

  @Get("boom")
  boom(): never {
    throw new Error("not a resilience error");
  }
}

@Module({ controllers: [ProxyController] })
class AppModule {}

let app: INestApplication;
let base: string;

beforeEach(async () => {
  up = await upstream(json({ from: "upstream" }));
  breaker = new CircuitBreaker({ windowSize: 2, minimumCalls: 2, openMs: 7000, isFailure: isRetryableHttp });
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ResilienceExceptionFilter());
  await app.listen(0, "127.0.0.1");
  base = addressOf(app.getHttpServer() as Server);
});

afterEach(async () => {
  (app.getHttpServer() as Server).closeAllConnections();
  await app.close();
  await up.close();
});

describe("NestJS adapter (real Nest 10 app on platform-express, real upstream server)", () => {
  it("passes a normal answer through; @RequestSignal() gives a live, un-aborted signal", async () => {
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "upstream" });
    expect(lastSignal).toBeInstanceOf(AbortSignal);
    expect(lastSignal!.aborted).toBe(false);
  });

  it("upstream hangs -> 504 through the exception filter", async () => {
    up.setHandler(hang);
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe("dependency_timeout");
  });

  it("breaker open -> 503 with Retry-After; the upstream is not called", async () => {
    up.setHandler(status(503));
    await fetch(`${base}/proxy`);
    await fetch(`${base}/proxy`);
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(up.hits()).toBe(2);
  });

  it("a full bulkhead -> 503 overloaded", async () => {
    const hold = full.execute(() => new Promise<void>(() => {}));
    void hold;
    const res = await fetch(`${base}/full`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("overloaded");
  });

  it("other errors keep Nest's own handling (500 Internal server error); an upstream 401 is not passed on", async () => {
    const boom = await fetch(`${base}/boom`);
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ statusCode: 500, message: "Internal server error" });
    up.setHandler(status(401));
    expect((await fetch(`${base}/proxy`)).status).toBe(500);
  });

  it("the client disconnects -> the signal aborts with ClientClosedError and the upstream sees the close", async () => {
    up.setHandler(hang);
    const client = new AbortController();
    const p = fetch(`${base}/proxy`, { signal: client.signal }).catch(() => {});
    await eventually(() => up.hits() === 1);
    client.abort();
    await p;
    await eventually(() => up.closedEarly() === 1);
    expect(lastSignal!.reason).toBeInstanceOf(ClientClosedError);
  });
});
