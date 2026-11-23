import { describe, expect, it } from "vitest";
import { LruCache } from "../src/cache.js";
import { Cached } from "../src/cached.js";

describe("@Cached method decorator (no framework)", () => {
  it("caches by the key of the arguments and keeps `this`", async () => {
    const cache = new LruCache<string, string>({ maxEntries: 10 });
    class Greeter {
      calls = 0;
      constructor(readonly greeting: string) {}
      @Cached(cache, { key: (name: string) => `hello:${name}` })
      async greet(name: string): Promise<string> {
        this.calls++;
        return `${this.greeting} ${name}`;
      }
    }
    const g = new Greeter("hi");
    expect([await g.greet("ann"), await g.greet("ann"), await g.greet("bo")]).toEqual(["hi ann", "hi ann", "hi bo"]);
    expect(g.calls).toBe(2);
  });

  it("concurrent calls with the same key share ONE call", async () => {
    const cache = new LruCache<string, number>({ maxEntries: 10 });
    let calls = 0;
    class Svc {
      @Cached(cache, { key: () => "k" })
      async slow(): Promise<number> {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return 5;
      }
    }
    const s = new Svc();
    expect(await Promise.all(Array.from({ length: 10 }, () => s.slow()))).toEqual(Array(10).fill(5));
    expect(calls).toBe(1);
  });

  it("key undefined -> not cached; an error is not cached", async () => {
    const cache = new LruCache<string, string>({ maxEntries: 10 });
    let calls = 0;
    class Svc {
      @Cached(cache, { key: (id?: string) => (id === undefined ? undefined : `x:${id}`) })
      async get(id?: string): Promise<string> {
        if (++calls === 3) throw new Error("boom");
        return `v${calls}`;
      }
    }
    const s = new Svc();
    expect([await s.get(), await s.get()]).toEqual(["v1", "v2"]); // uncached: runs every time
    await expect(s.get("a")).rejects.toThrow("boom");
    expect(await s.get("a")).toBe("v4"); // the error was not cached
    expect(await s.get("a")).toBe("v4");
  });

  it("the shared result: the method runs with the FIRST caller's `this` (why the key must capture instance differences)", async () => {
    const cache = new LruCache<string, string>({ maxEntries: 10 });
    class Tenant {
      constructor(readonly name: string) {}
      @Cached(cache, { key: () => "config" }) // WRONG on purpose: the key ignores the tenant
      async config(): Promise<string> {
        return `config of ${this.name}`;
      }
    }
    expect(await new Tenant("a").config()).toBe("config of a");
    expect(await new Tenant("b").config()).toBe("config of a"); // b got a's value: put the tenant in the key
  });

  it("passes ttlMs on: after it the method runs again", async () => {
    let t = 0;
    const cache = new LruCache<string, number>({ maxEntries: 10, now: () => t }); // no default TTL
    let calls = 0;
    class Svc {
      @Cached(cache, { key: () => "k", ttlMs: 1000 })
      async v(): Promise<number> {
        return ++calls;
      }
    }
    const s = new Svc();
    expect(await s.v()).toBe(1);
    t = 999;
    expect(await s.v()).toBe(1);
    t = 1001;
    expect(await s.v()).toBe(2);
  });

  it("refuses to decorate something that is not a method", () => {
    const cache = new LruCache<string, string>({ maxEntries: 10 });
    expect(() => Cached(cache, { key: () => "k" })({}, "x", { value: 42 })).toThrow(TypeError);
  });
});
