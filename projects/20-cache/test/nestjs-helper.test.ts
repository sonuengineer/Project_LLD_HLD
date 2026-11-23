import "reflect-metadata";
import { Controller, Get, Module, Param, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cached, CachedRoute } from "../src/adapters/nestjs.js";
import { LruCache } from "../src/cache.js";

const routeCache = new LruCache<string, unknown>({ maxEntries: 100, ttlMs: 60_000 });
const serviceCache = new LruCache<string, { id: string; n: number }>({ maxEntries: 100, ttlMs: 60_000 });
const runs = { route: 0, service: 0, failing: 0 };
const params = (req: IncomingMessage) => (req as unknown as { params: Record<string, string> }).params;

// A service with a cached method: used by the controller below, no DI needed for the cache.
class ProductService {
  @Cached(serviceCache, { key: (id: string) => `product:${id}` })
  async find(id: string): Promise<{ id: string; n: number }> {
    runs.service++;
    return { id, n: runs.service };
  }
}
const products = new ProductService();

@Controller()
class DemoController {
  @Get("route/:id")
  @CachedRoute(routeCache, { key: (req) => `route:${params(req).id}` })
  route(@Param("id") id: string): { id: string; n: number } {
    runs.route++;
    return { id, n: runs.route };
  }

  @Get("missing/:id")
  @CachedRoute(routeCache, { key: (req) => `missing:${params(req).id}` })
  missing(): null {
    return null;
  }

  @Get("failing")
  @CachedRoute(routeCache, { key: () => "failing" })
  failing(): string {
    if (++runs.failing === 1) throw new Error("db down");
    return "recovered";
  }

  @Get("service/:id")
  service(@Param("id") id: string): Promise<{ id: string; n: number }> {
    return products.find(id);
  }
}

@Module({ controllers: [DemoController] })
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

describe("NestJS helpers (real Nest 10 app, platform-express)", () => {
  it("@CachedRoute: miss then hit; on a hit the handler does not run", async () => {
    const a = await fetch(`${base}/route/1`);
    const b = await fetch(`${base}/route/1`);
    expect([a.headers.get("x-cache"), await a.json()]).toEqual(["miss", { id: "1", n: 1 }]);
    expect([b.headers.get("x-cache"), await b.json()]).toEqual(["hit", { id: "1", n: 1 }]);
    expect(runs.route).toBe(1);
  });

  it("@CachedRoute: 10 concurrent requests run the handler once", async () => {
    const before = runs.route;
    const rs = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/route/2`)));
    expect(runs.route - before).toBe(1);
    expect(new Set(await Promise.all(rs.map((r) => r.text()))).size).toBe(1);
  });

  it("@CachedRoute: a null result is Nest's 404", async () => {
    const r = await fetch(`${base}/missing/9`);
    expect(r.status).toBe(404);
  });

  it("@CachedRoute: an error is not cached -- 500 first, then the handler runs again", async () => {
    expect((await fetch(`${base}/failing`)).status).toBe(500);
    const r = await fetch(`${base}/failing`);
    expect([r.status, await r.text(), r.headers.get("x-cache")]).toEqual([200, "recovered", "miss"]);
  });

  it("@Cached on a service method: one call per id, shared by every caller", async () => {
    const a = await (await fetch(`${base}/service/7`)).json();
    const b = await (await fetch(`${base}/service/7`)).json();
    const c = await (await fetch(`${base}/service/8`)).json();
    expect([a, b, c]).toEqual([{ id: "7", n: 1 }, { id: "7", n: 1 }, { id: "8", n: 2 }]);
    expect(runs.service).toBe(2);
  });
});
