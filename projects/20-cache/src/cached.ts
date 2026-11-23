// @Cached: cache an async METHOD's result, e.g. on a NestJS service or any class. Framework-free (a plain
// TypeScript legacy method decorator, the kind NestJS uses -- needs "experimentalDecorators").
//
//   class ProductService {
//     @Cached(productCache, { key: (id: string) => `product:${id}`, ttlMs: 60_000 })
//     async find(id: string) { return db.products.find(id); }
//   }
//
// key(...args) -> the cache key; undefined -> call the method uncached. Concurrent calls with the same key share ONE
// call (single flight). The method runs with the FIRST caller's `this` and arguments, so the key must capture every
// argument (and every instance difference) the result depends on. An error is not cached.
// Note: a method has no AbortSignal, so a caller cannot abandon the shared call.
import type { Loadable } from "./adapters/http.js";
import type { SetOptions } from "./cache.js";

export interface CachedOptions<A extends unknown[]> extends SetOptions {
  key: (...args: A) => string | undefined;
}

export function Cached<V, A extends unknown[] = unknown[]>(cache: Loadable<V>, options: CachedOptions<A>) {
  return function (_target: object, _property: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor {
    const original = descriptor.value as (...args: A) => Promise<V> | V;
    if (typeof original !== "function") throw new TypeError("@Cached can only decorate a method");
    descriptor.value = function (this: unknown, ...args: A): Promise<V> {
      const key = options.key(...args);
      if (key === undefined) return Promise.resolve(original.apply(this, args));
      return cache.getOrLoad(key, () => original.apply(this, args), { ttlMs: options.ttlMs, staleMs: options.staleMs });
    };
    return descriptor;
  };
}
