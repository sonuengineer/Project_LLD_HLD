// NestJS adapter (platform-express). @nestjs/common is an optional peer dependency: only this entry point needs it.
import { Catch, createParamDecorator, type ArgumentsHost, type ExceptionFilter, type ExecutionContext } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BrokenCircuitError, BulkheadRejectedError, TimeoutError } from "../errors.js";
import { requestSignal } from "./express.js";
import { mapResilienceError } from "./http-status.js";

// Controller parameter: an AbortSignal aborted when the client disconnects.
//   @Post() send(@Body() dto: SmsDto, @RequestSignal() signal: AbortSignal) { return this.sms.send(dto, signal); }
export const RequestSignal = createParamDecorator((_data: unknown, ctx: ExecutionContext): AbortSignal => {
  const http = ctx.switchToHttp();
  return requestSignal(http.getRequest<IncomingMessage>(), http.getResponse<ServerResponse>());
});

// Exception filter with the same mapping as the Express middleware: 503 (+ Retry-After) for an open breaker or a full
// bulkhead, 504 for a timeout. Register globally: app.useGlobalFilters(new ResilienceExceptionFilter()).
// Other exceptions are not caught by it (Nest's own handling stays as it was).
@Catch(BrokenCircuitError, BulkheadRejectedError, TimeoutError)
export class ResilienceExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    const mapped = mapResilienceError(exception)!;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = mapped.status;
    for (const [name, value] of Object.entries(mapped.headers)) res.setHeader(name, value);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(mapped.body));
  }
}
