// Stage 3: the HTTP API in front of the QueuedNotifier. For other SERVICES (an order service, an auth service), not
// browsers: one API key, no CORS, no per-user login.
//
//   POST /notifications            Idempotency-Key header + { typeId, userId, data }
//        202 new (queued; Location: /notifications/<id>)
//        200 replay of an earlier request with the same key and body (Idempotent-Replayed: true; nothing queued)
//        409 same key, different body
//   GET  /notifications/:id        the record and its overall status
//   GET  /users/:userId/preferences
//   PUT  /users/:userId/preferences
//   POST /webhooks/:channel        a provider's delivery receipt, signed with that channel's secret (not the API key)
//        200 { result: "applied" | "unchanged" }, 202 { result: "parked" } (see receipts.ts)
//
// Status codes: 400 the request is malformed (bad JSON, missing header, wrong types), 401 no or wrong API key,
// 404 no such resource in the URL, 409 idempotency conflict, 413 body over the limit, 415 not JSON, 422 well-formed but impossible
// (unknown type or user in the body, a template variable missing, invalid preferences), 500 our fault (message
// hidden). Every error is { "error": { "code", "message" } }, so callers switch on `code`.
//
// The handlers are synchronous on purpose: QueuedNotifier.notify() does not await (stage 2), and in Express 4 a
// synchronous throw reaches the error handler while a rejected promise would not.
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { systemClock, type Clock } from "../clock.js";
import { NotificationError, type NotificationErrorCode } from "../errors.js";
import type { PreferenceStore } from "../preferences.js";
import type { QueuedNotifier } from "../queued-notifier.js";
import { isReceiptEvent, SIGNATURE_HEADER, verifyWebhook } from "../receipts.js";
import { notificationStatus, type NotificationRecord } from "../record.js";
import { isChannel, type Channel } from "../types.js";
import type { UserDirectory } from "../users.js";

export interface AppOptions {
  notifier: QueuedNotifier;
  users: UserDirectory;
  preferences: PreferenceStore;
  apiKey: string; // from an environment variable; required, there is no open mode
  bodyLimit?: string; // default "64kb"
  log?: (message: string, error: unknown) => void; // unexpected (500) errors; default console.error
  webhookSecrets?: Partial<Record<Channel, string>>; // one per provider; a channel without one has no webhook (404)
  clock?: Clock; // for the webhook timestamp check; default the system clock
}

export const MIN_API_KEY_LENGTH = 16;

// An error the HTTP layer raises itself (as opposed to a NotificationError from the library).
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<NotificationErrorCode, number> = {
  INVALID_REQUEST: 400,
  IDEMPOTENCY_CONFLICT: 409,
  UNKNOWN_TYPE: 422,
  UNKNOWN_USER: 422,
  TEMPLATE_VARIABLE_MISSING: 422,
  INVALID_PREFERENCES: 422,
  NO_SENDER: 500, // the server is missing a sender for a channel: not the caller's fault
  INVALID_TYPE: 500, // catalog errors happen at startup, never from a request
  DUPLICATE_TYPE: 500,
};

const digest = (s: string) => createHash("sha256").update(s).digest();

// Constant time: comparing digests (always 32 bytes) means neither the content nor the LENGTH of the key leaks
// through how long a wrong guess takes to be refused.
function keyMatches(expected: Buffer, header: string | undefined): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  return match !== null && timingSafeEqual(expected, digest(match[1]!));
}

function view(record: NotificationRecord) {
  return { ...record, status: notificationStatus(record) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createApp(options: AppOptions): express.Express {
  if (typeof options.apiKey !== "string" || options.apiKey.length < MIN_API_KEY_LENGTH) {
    throw new RangeError(`apiKey must be a string of at least ${MIN_API_KEY_LENGTH} characters`);
  }
  const expected = digest(options.apiKey);
  const secrets = options.webhookSecrets ?? {};
  for (const [channel, secret] of Object.entries(secrets)) {
    if (!isChannel(channel)) throw new RangeError(`webhookSecrets: unknown channel ${channel}`);
    if (typeof secret !== "string" || secret.length < MIN_API_KEY_LENGTH) {
      throw new RangeError(`webhookSecrets.${channel} must be a string of at least ${MIN_API_KEY_LENGTH} characters`);
    }
  }
  const clock = options.clock ?? systemClock;
  const { notifier, users, preferences } = options;
  const bodyLimit = options.bodyLimit ?? "64kb";
  const log = options.log ?? ((message, error) => console.error(message, error));

  const app = express();
  app.disable("x-powered-by");

  // Webhooks come from providers, who prove who they are with a signature, not with our API key -- so this route is
  // registered BEFORE the API-key check. It reads the RAW body: the signature is over the exact bytes sent.
  app.post("/webhooks/:channel", express.raw({ type: "application/json", limit: bodyLimit }), (req, res) => {
    const channel = req.params.channel!;
    const secret = isChannel(channel) ? secrets[channel] : undefined;
    if (secret === undefined) throw new HttpError(404, "NOT_FOUND", "no webhook for this channel");
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
    if (!verifyWebhook(secret, req.get(SIGNATURE_HEADER), req.body, clock.now())) {
      throw new HttpError(401, "INVALID_SIGNATURE", "missing, wrong or expired signature");
    }
    let body: unknown;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      throw new HttpError(400, "INVALID_JSON", "body is not valid JSON");
    }
    if (!isPlainObject(body)) throw new HttpError(400, "INVALID_RECEIPT", "body must be a JSON object");
    const { providerId, event, occurredAt } = body;
    if (typeof providerId !== "string" || providerId === "" || providerId.length > 255) {
      throw new HttpError(400, "INVALID_RECEIPT", "providerId must be a non-empty string of at most 255 characters");
    }
    if (!isReceiptEvent(event)) throw new HttpError(400, "INVALID_RECEIPT", "event must be delivered or bounced");
    if (typeof occurredAt !== "number" || !Number.isFinite(occurredAt)) {
      throw new HttpError(400, "INVALID_RECEIPT", "occurredAt must be epoch milliseconds");
    }
    const result = notifier.applyReceipt(channel as Channel, providerId, { event, at: occurredAt });
    res.status(result === "parked" ? 202 : 200).json({ result });
  });

  // Auth first: an unauthenticated caller gets 401 before its body is even parsed.
  app.use((req, _res, next) => {
    if (!keyMatches(expected, req.get("authorization"))) throw new HttpError(401, "UNAUTHORIZED", "missing or wrong API key");
    next();
  });
  app.use(express.json({ limit: bodyLimit }));
  // Without this, a body sent as text/plain would be silently ignored and the caller would get a confusing 400.
  const requireJson = (req: Request) => {
    if (!req.is("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  };

  app.post("/notifications", (req, res) => {
    requireJson(req);
    const idempotencyKey = req.get("idempotency-key");
    if (idempotencyKey === undefined) throw new HttpError(400, "INVALID_REQUEST", "Idempotency-Key header is required");
    const body: unknown = req.body;
    if (!isPlainObject(body)) throw new HttpError(400, "INVALID_REQUEST", "body must be a JSON object");
    const { typeId, userId, data } = body;
    if (typeof typeId !== "string") throw new HttpError(400, "INVALID_REQUEST", "typeId must be a string");
    if (typeof userId !== "string") throw new HttpError(400, "INVALID_REQUEST", "userId must be a string");

    // Both calls are synchronous, so nothing can run between them: if the key was unknown just before notify(),
    // this request is the one that created the record.
    const before = notifier.getByKey(idempotencyKey);
    const record = notifier.notify({ typeId, userId, data: data as Record<string, unknown>, idempotencyKey });
    if (before?.id === record.id) {
      res.status(200).set("Idempotent-Replayed", "true").json(view(record));
      return;
    }
    res.status(202).location(`/notifications/${encodeURIComponent(record.id)}`).json(view(record));
  });

  app.get("/notifications/:id", (req, res) => {
    const record = notifier.get(req.params.id!);
    if (!record) throw new HttpError(404, "NOT_FOUND", "no such notification");
    res.json(view(record));
  });

  const requireUser = (userId: string) => {
    if (!users.get(userId)) throw new HttpError(404, "NOT_FOUND", "no such user");
  };

  app.get("/users/:userId/preferences", (req, res) => {
    requireUser(req.params.userId!);
    res.json(preferences.get(req.params.userId!));
  });

  // A whole replacement (PUT), not a merge: what the caller sends is what is stored.
  app.put("/users/:userId/preferences", (req, res) => {
    requireUser(req.params.userId!);
    requireJson(req);
    preferences.set(req.params.userId!, req.body);
    res.json(preferences.get(req.params.userId!));
  });

  app.use(() => {
    throw new HttpError(404, "NOT_FOUND", "no such route");
  });

  // Four arguments: this is how Express recognises an error handler.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, code, message } = toHttp(error, log);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

function toHttp(error: unknown, log: NonNullable<AppOptions["log"]>): { status: number; code: string; message: string } {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof NotificationError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    if (status >= 500) {
      log("notification API: server-side error", error);
      return { status, code: "INTERNAL", message: "internal error" };
    }
    return { status, code: error.code, message: error.message };
  }
  // body-parser's own errors carry a `type`.
  const type = (error as { type?: unknown } | null)?.type;
  if (type === "entity.parse.failed") return { status: 400, code: "INVALID_JSON", message: "body is not valid JSON" };
  if (type === "entity.too.large") return { status: 413, code: "BODY_TOO_LARGE", message: "body is over the size limit" };
  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    return { status: 415, code: "UNSUPPORTED_ENCODING", message: "unsupported body encoding" };
  }
  log("notification API: unexpected error", error);
  return { status: 500, code: "INTERNAL", message: "internal error" };
}
