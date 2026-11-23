// NestJS helpers (cache-kit/nestjs, platform-express). @nestjs/common and rxjs are optional peer dependencies:
// only this entry point needs them.
import {
  applyDecorators,
  NotFoundException,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { from, lastValueFrom, type Observable } from "rxjs";
import { isNotFound, loadForRequest, requestSignal, type CachedResponseOptions, type Loadable } from "./http.js";

// An interceptor INSTANCE per decorated route (no dependency injection): on a miss the handler runs (next.handle());
// on a hit, or while another request's load for the same key is running, the handler does NOT run at all.
// Sets X-Cache: hit | stale | miss | bypass. A "not found" value (default null / undefined) -> Nest's 404.
// A handler error is not cached and reaches Nest's exception layer. Unlike the Express helper, a client that has gone
// is not special-cased: its aborted wait also goes to Nest's exception layer (which writes to a closed connection,
// a no-op), and the handler gets no abort signal (Nest handlers take none).
export class CachedRouteInterceptor<V> implements NestInterceptor {
  constructor(
    private readonly cache: Loadable<V>,
    private readonly options: CachedResponseOptions<V>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<V> {
    const http = context.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    return from(
      (async () => {
        const { value, status } = await loadForRequest(this.cache, this.options, req, requestSignal(res), () =>
          lastValueFrom(next.handle() as Observable<V>),
        );
        if (!res.headersSent) res.setHeader("x-cache", status);
        if ((this.options.notFound ?? isNotFound)(value)) throw new NotFoundException();
        return value;
      })(),
    );
  }
}

// @Get(":id") @CachedRoute(cache, { key: (req) => `product:${(req as any).params.id}`, ttlMs: 60_000 })
export function CachedRoute<V>(cache: Loadable<V>, options: CachedResponseOptions<V>) {
  return applyDecorators(UseInterceptors(new CachedRouteInterceptor(cache, options)));
}

export { Cached } from "../cached.js";
export { type CachedResponseOptions, type CacheKeyFn, type CacheStatus, type Loadable } from "./http.js";
