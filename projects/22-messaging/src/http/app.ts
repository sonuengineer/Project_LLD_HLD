// Stage 3: the HTTP API in front of the Messenger. For other SERVICES, not browsers: one API key, no CORS,
// no per-user login -- the same security model as the sibling 21-notification/23-password-manager layers.
//
//   POST   /conversations/direct                         { userIdA, userIdB }                200 Conversation
//   POST   /conversations/group                           { ownerId, memberIds, name }         201 Conversation
//   GET    /conversations/:conversationId                                                      200 Conversation
//   POST   /conversations/:conversationId/members          { actingUserId, newUserId }          200 Conversation
//   DELETE /conversations/:conversationId/members/:targetUserId  { actingUserId }                200 Conversation
//   POST   /conversations/:conversationId/messages          { senderId, body, clientMessageId }  201 MessageView
//   GET    /conversations/:conversationId/messages?memberId=&limit=&cursor=                     200 MessagePageView
//   GET    /conversations/:conversationId/messages/:messageId                                   200 MessageView
//   PATCH  /conversations/:conversationId/messages/:messageId   { senderId, body }               200 MessageView
//   DELETE /conversations/:conversationId/messages/:messageId   { senderId }                     200 MessageView
//   POST   /conversations/:conversationId/messages/:messageId/delivered  { recipientId }          200 Receipt
//   POST   /conversations/:conversationId/read              { recipientId, uptoSeq }             200 { marked }
//   POST   /users/:userId/devices                           { deviceId? }                        200 { deviceId }
//   DELETE /users/:userId/devices/:deviceId                                                       204
//   GET    /users/:userId/online                                                                  200 { online }
//
// Status codes: 400 malformed request, 401 no/wrong API key, 403 the caller is not allowed to do this (not a
// member, not the owner, not the sender), 404 no such resource, 409 a state conflict (already a member, the
// owner can't be removed, an idempotency conflict, a busy conversation, a deleted message), 413 body over the
// limit, 415 not JSON, 500 something truly unexpected (logged, never leaked). None of this library's own error
// codes maps to 500 -- see STATUS_BY_CODE. Every error is { "error": { "code", "message" } }.
//
// Every mutating Messenger call is async (stage 2's real ConversationStore round trip); Express 4 does not
// route a rejected promise to the error handler on its own, so every route that awaits one goes through
// asyncRoute() below. Routes that call a SYNCHRONOUS Messenger method (createDirectConversation,
// createGroupConversation, get, getMessage, getMessages, isOnline, disconnectDevice) do not need it -- Express
// 4 already routes a synchronous throw to the error handler.
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { MessagingError, type MessagingErrorCode } from "../errors.js";
import { overallStatus, type Messenger } from "../messenger.js";
import type { Message } from "../types.js";

export interface AppOptions {
  messenger: Messenger;
  apiKey: string; // from an environment variable; required, there is no open mode
  bodyLimit?: string; // default "64kb"
  log?: (message: string, error: unknown) => void; // unexpected (500) errors; default console.error
}

export const MIN_API_KEY_LENGTH = 16;

// An error the HTTP layer raises itself (as opposed to a MessagingError from the library).
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<MessagingErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNKNOWN_USER: 404,
  UNKNOWN_CONVERSATION: 404,
  UNKNOWN_MESSAGE: 404,
  NOT_A_MEMBER: 403,
  ALREADY_MEMBER: 409,
  OWNER_REQUIRED: 403,
  CANNOT_REMOVE_OWNER: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_CURSOR: 400,
  CONVERSATION_BUSY: 409,
  SEND_IN_FLIGHT: 409,
  SENDER_REQUIRED: 403,
  MESSAGE_DELETED: 409,
  UNKNOWN_DEVICE: 404,
};

const digest = (s: string) => createHash("sha256").update(s).digest();

// Constant time: comparing digests (always 32 bytes) means neither the content nor the LENGTH of the key
// leaks through how long a wrong guess takes to be refused.
function keyMatches(expected: Buffer, header: string | undefined): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  return match !== null && timingSafeEqual(expected, digest(match[1]!));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Adds the computed overall (worst-of-receipts) status to a message, the same way notification's `view()`
// adds a computed `status` to a record -- never stored, always derived.
function messageView(message: Message) {
  return { ...message, status: overallStatus(message) };
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function createApp(options: AppOptions): express.Express {
  if (typeof options.apiKey !== "string" || options.apiKey.length < MIN_API_KEY_LENGTH) {
    throw new RangeError(`apiKey must be a string of at least ${MIN_API_KEY_LENGTH} characters`);
  }
  const expected = digest(options.apiKey);
  const { messenger } = options;
  const bodyLimit = options.bodyLimit ?? "64kb";
  const log = options.log ?? ((message, error) => console.error(message, error));

  const app = express();
  app.disable("x-powered-by");

  // Auth first: an unauthenticated caller gets 401 before its body is even parsed.
  app.use((req, _res, next) => {
    if (!keyMatches(expected, req.get("authorization"))) throw new HttpError(401, "UNAUTHORIZED", "missing or wrong API key");
    next();
  });
  app.use(express.json({ limit: bodyLimit }));
  // Without this, a body sent as text/plain would be silently ignored and the caller would get a confusing
  // downstream error (fields read as undefined) instead of a direct "you sent the wrong Content-Type."
  const requireJson = (req: Request) => {
    if (!req.is("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  };
  // Field-level type checking is deliberately NOT duplicated here: every Messenger method already validates its
  // own inputs (body/id length, unknown user, unknown conversation, not a member, ...) and throws a mapped
  // MessagingError, so a field is simply read off the body and handed straight through.
  const bodyField = (req: Request, field: string): unknown => (isPlainObject(req.body) ? req.body[field] : undefined);

  app.post("/conversations/direct", (req, res) => {
    requireJson(req);
    const conv = messenger.createDirectConversation(bodyField(req, "userIdA") as string, bodyField(req, "userIdB") as string);
    res.status(200).json(conv);
  });

  app.post("/conversations/group", (req, res) => {
    requireJson(req);
    const conv = messenger.createGroupConversation(bodyField(req, "ownerId") as string, bodyField(req, "memberIds") as string[], bodyField(req, "name") as string);
    res.status(201).location(`/conversations/${encodeURIComponent(conv.id)}`).json(conv);
  });

  app.get("/conversations/:conversationId", (req, res) => {
    const conv = messenger.get(req.params.conversationId!);
    if (!conv) throw new HttpError(404, "NOT_FOUND", "no such conversation");
    res.json(conv);
  });

  app.post(
    "/conversations/:conversationId/members",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const conv = await messenger.addMember(req.params.conversationId!, bodyField(req, "actingUserId") as string, bodyField(req, "newUserId") as string);
      res.json(conv);
    }),
  );

  app.delete(
    "/conversations/:conversationId/members/:targetUserId",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const conv = await messenger.removeMember(req.params.conversationId!, bodyField(req, "actingUserId") as string, req.params.targetUserId!);
      res.json(conv);
    }),
  );

  app.post(
    "/conversations/:conversationId/messages",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const message = await messenger.sendMessage(
        req.params.conversationId!,
        bodyField(req, "senderId") as string,
        bodyField(req, "body") as string,
        bodyField(req, "clientMessageId") as string,
      );
      res
        .status(201)
        .location(`/conversations/${encodeURIComponent(req.params.conversationId!)}/messages/${encodeURIComponent(message.id)}`)
        .json(messageView(message));
    }),
  );

  // `limit` is converted with Number() and handed to getMessages exactly as-is: a garbled value (non-numeric,
  // an array from a repeated query key, ...) becomes NaN, which Messenger's own `Number.isInteger` guard already
  // rejects as INVALID_REQUEST -- no HTTP-level duplicate needed, the outcome is identical either way.
  //
  // `cursor` is different: decodeCursor() calls Buffer.from(cursor, "base64url") directly, and Buffer.from throws
  // a raw TypeError (not a MessagingError) when given something that is not a string -- e.g. a repeated query key
  // parsed into a plain object (`?cursor[x]=1`) -- which would otherwise leak out as an uncontrolled 500 instead
  // of a clean 400. This is the one HTTP-level structural check this layer adds that the library has no
  // equivalent guard for (same category as 23-password-manager's share-token-shape check): everything else is
  // read off the request and handed straight to Messenger's own validation.
  app.get("/conversations/:conversationId/messages", (req, res) => {
    const { memberId, limit, cursor } = req.query;
    if (cursor !== undefined && typeof cursor !== "string") throw new HttpError(400, "INVALID_CURSOR", "a cursor must be a single string");
    const page = messenger.getMessages(req.params.conversationId!, memberId as string, {
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    res.json({ items: page.items.map(messageView), nextCursor: page.nextCursor });
  });

  app.get("/conversations/:conversationId/messages/:messageId", (req, res) => {
    const message = messenger.getMessage(req.params.conversationId!, req.params.messageId!);
    if (!message) throw new HttpError(404, "NOT_FOUND", "no such message");
    res.json(messageView(message));
  });

  app.patch(
    "/conversations/:conversationId/messages/:messageId",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const message = await messenger.editMessage(req.params.conversationId!, bodyField(req, "senderId") as string, req.params.messageId!, bodyField(req, "body") as string);
      res.json(messageView(message));
    }),
  );

  app.delete(
    "/conversations/:conversationId/messages/:messageId",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const message = await messenger.deleteMessage(req.params.conversationId!, bodyField(req, "senderId") as string, req.params.messageId!);
      res.json(messageView(message));
    }),
  );

  app.post(
    "/conversations/:conversationId/messages/:messageId/delivered",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const receipt = await messenger.markDelivered(req.params.conversationId!, bodyField(req, "recipientId") as string, req.params.messageId!);
      res.json(receipt);
    }),
  );

  app.post(
    "/conversations/:conversationId/read",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const result = await messenger.markReadUpTo(req.params.conversationId!, bodyField(req, "recipientId") as string, bodyField(req, "uptoSeq") as number);
      res.json(result);
    }),
  );

  // deviceId is optional (the library generates one when omitted), so this route does not requireJson: a
  // caller connecting with no body at all is normal, not a Content-Type mistake.
  app.post(
    "/users/:userId/devices",
    asyncRoute(async (req, res) => {
      const deviceId = await messenger.connectDevice(req.params.userId!, bodyField(req, "deviceId") as string | undefined);
      res.status(200).json({ deviceId });
    }),
  );

  app.delete("/users/:userId/devices/:deviceId", (req, res) => {
    messenger.disconnectDevice(req.params.userId!, req.params.deviceId!);
    res.status(204).end();
  });

  app.get("/users/:userId/online", (req, res) => {
    res.json({ online: messenger.isOnline(req.params.userId!) });
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
  if (error instanceof MessagingError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    if (status >= 500) {
      log("messaging API: server-side error", error);
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
  log("messaging API: unexpected error", error);
  return { status: 500, code: "INTERNAL", message: "internal error" };
}
