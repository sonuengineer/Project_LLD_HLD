import "reflect-metadata";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimit } from "../src/adapters/nestjs.js";
import { tokenBucket } from "../src/algorithms.js";
import { RateLimiter } from "../src/limiter.js";
import { MemoryStore } from "../src/memory-store.js";

const limiter = (capacity: number, prefix: string) =>
  new RateLimiter({ algorithm: tokenBucket({ capacity, refillPerSec: 0.001 }), store: new MemoryStore(), prefix });
let handled = 0;

@Controller()
class DemoController {
  @Get("open")
  open(): string {
    return "no limit here";
  }

  @Get("login")
  @RateLimit(limiter(2, "rl:login:"))
  login(): { ok: true } {
    handled++;
    return { ok: true };
  }

  // Stacked: per IP (generous) AND per user (strict); anonymous requests skip the per-user one.
  @Get("me")
  @RateLimit(limiter(100, "rl:me-ip:"))
  @RateLimit(limiter(1, "rl:me-user:"), { key: (req: IncomingMessage) => (req.headers["x-user"] as string | undefined) })
  me(): string {
    return "me";
  }
}

@Controller("limited")
@RateLimit(limiter(1, "rl:ctrl:"))
class LimitedController {
  @Get("a") a(): string {
    return "a";
  }
  @Get("b") b(): string {
    return "b";
  }
}

@Module({ controllers: [DemoController, LimitedController] })
class AppModule {}

let app: INestApplication;
let base: string;
beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});
afterAll(async () => {
  (app.getHttpServer() as Server).closeAllConnections();
  await app.close();
});

describe("NestJS @RateLimit (real Nest 10 app, platform-express)", () => {
  it("allowed with RateLimit-* headers, then Nest answers 429 with Retry-After and our body; the handler does not run", async () => {
    const ok1 = await fetch(`${base}/login`);
    const ok2 = await fetch(`${base}/login`);
    expect([ok1.status, ok1.headers.get("ratelimit-remaining"), ok2.headers.get("ratelimit-remaining")]).toEqual([200, "1", "0"]);
    const denied = await fetch(`${base}/login`);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(denied.headers.get("ratelimit-limit")).toBe("2");
    expect(await denied.json()).toEqual({ error: "rate_limited", message: "Too many requests. Try again later." });
    expect(handled).toBe(2);
  });

  it("an undecorated route has no limit and no headers", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/open`);
      expect([r.status, r.headers.get("ratelimit-limit")]).toEqual([200, null]);
    }
  });

  it("stacked decorators: per-user limit for a user, skipped for anonymous requests", async () => {
    const as = (user?: string) => fetch(`${base}/me`, { headers: user ? { "x-user": user } : {} }).then((r) => r.status);
    expect([await as("alice"), await as("alice"), await as("bob"), await as(), await as()]).toEqual([200, 429, 200, 200, 200]);
  });

  it("on a controller: one limit shared by all its routes", async () => {
    expect([(await fetch(`${base}/limited/a`)).status, (await fetch(`${base}/limited/b`)).status]).toEqual([200, 429]);
  });
});
