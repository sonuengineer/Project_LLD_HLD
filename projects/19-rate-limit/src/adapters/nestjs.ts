// NestJS adapter (platform-express). @nestjs/common is an optional peer dependency: only this entry point needs it.
import {
  applyDecorators,
  HttpException,
  HttpStatus,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RateLimiter } from "../limiter.js";
import { RateLimitError, type Decision } from "../types.js";
import {
  keyByIp,
  setHeaders,
  STORE_UNAVAILABLE_BODY,
  STORE_UNAVAILABLE_RETRY_AFTER_S,
  TOO_MANY_REQUESTS_BODY,
  type KeyFn,
  type OnStoreError,
} from "./http.js";

export interface RateLimitGuardOptions {
  key?: KeyFn; // default keyByIp(); undefined -> not limited by this guard
  cost?: (req: IncomingMessage) => number;
  headers?: boolean; // default true
  onStoreError?: OnStoreError; // see adapters/http.ts; default "error"
}

// A guard INSTANCE per decorated route/controller, holding its limiter: no dependency injection needed.
export class RateLimitGuard implements CanActivate {
  private readonly keyFn: KeyFn;

  constructor(
    private readonly limiter: RateLimiter,
    private readonly options: RateLimitGuardOptions = {},
  ) {
    this.keyFn = options.key ?? keyByIp();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    const key = await this.keyFn(req);
    if (key === undefined) return true;
    let decision: Decision;
    try {
      decision = await this.limiter.consume(key, this.options.cost?.(req) ?? 1);
    } catch (error) {
      const mode = this.options.onStoreError ?? "error";
      if (error instanceof RateLimitError || mode === "error") throw error;
      if (mode === "allow") return true;
      res.setHeader("retry-after", String(STORE_UNAVAILABLE_RETRY_AFTER_S));
      throw new HttpException(STORE_UNAVAILABLE_BODY, HttpStatus.SERVICE_UNAVAILABLE);
    }
    if ((this.options.headers ?? true) || !decision.allowed) setHeaders(res, decision);
    if (decision.allowed) return true;
    // Headers are already on the response; Nest's exception layer writes status and body.
    throw new HttpException(TOO_MANY_REQUESTS_BODY, HttpStatus.TOO_MANY_REQUESTS);
  }
}

// @RateLimit(loginLimiter, { key: (req) => ..., onStoreError: "deny" }) on a controller or a handler.
// Several can be stacked (e.g. per IP AND per account); each is its own guard.
export function RateLimit(limiter: RateLimiter, options: RateLimitGuardOptions = {}) {
  return applyDecorators(UseGuards(new RateLimitGuard(limiter, options)));
}

export { clientIp, ipKey, keyByIp, rateLimitHeaders, type KeyFn, type OnStoreError } from "./http.js";
