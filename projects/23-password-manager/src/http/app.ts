// Stage 7: the HTTP API in front of PasswordManager. For other SERVICES, not browsers: one API key, no CORS,
// no per-user login -- the SAME security model as the library itself (a sessionId proves which vault a call
// is acting on, a master password proves you know it; this layer adds only "are you a legitimate caller of
// this API at all").
//
//   POST   /vaults                                      { ownerId, masterPassword }       201 VaultSummary
//   GET    /vaults/:ownerId                                                                200 VaultSummary
//   POST   /vaults/:ownerId/unlock                       { masterPassword }                200 UnlockResult
//   POST   /vaults/:ownerId/rotate                       { oldPassword, newPassword }       204
//   GET    /vaults/:ownerId/export                                                          200 VaultExport
//   POST   /sessions/:sessionId/lock                                                        204
//   GET    /sessions/:sessionId                                                             200 { active }
//   POST   /sessions/:sessionId/entries                  EntryInput                         201 EntrySummary
//   GET    /sessions/:sessionId/entries                                                     200 EntrySummary[]
//   GET    /sessions/:sessionId/entries/:entryId                                            200 EntryDetail
//   PATCH  /sessions/:sessionId/entries/:entryId         Partial<EntryInput>                 200 EntrySummary
//   DELETE /sessions/:sessionId/entries/:entryId                                             204
//   GET    /sessions/:sessionId/sharing-key                                                  200 { publicKey }
//   POST   /sessions/:sessionId/entries/:entryId/share   { recipientPublicKey }              201 SharedEntryToken
//   POST   /sessions/:sessionId/shares/redeem            SharedEntryToken                    201 EntrySummary
//   POST   /sessions/:sessionId/shares/:shareId/revoke                                       204
//   POST   /breach-check                                 { password }                        200 { breached }
//
// Status codes: 400 malformed request, 401 no/wrong API key or a session/password problem, 404 no such
// resource, 409 a conflicting operation or state, 410 a revoked share, 423 locked out, 503 the store did not
// respond in time. Every error is { "error": { "code", "message" } }, so callers switch on `code`.
//
// Every mutating PasswordManager call is async; Express 4 does not route a rejected promise to the error
// handler on its own, so every route that awaits one goes through asyncRoute() below. Routes that call a
// SYNCHRONOUS PasswordManager method (createVault, unlock, shareEntry, revokeShare, ...) do not need it --
// Express 4 already routes a synchronous throw to the error handler.
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { PasswordManagerError, type PasswordManagerErrorCode } from "../errors.js";
import type { PasswordManager } from "../manager.js";
import type { EntryInput, SharedEntryToken } from "../types.js";

export interface AppOptions {
  manager: PasswordManager;
  apiKey: string; // from an environment variable; required, there is no open mode
  bodyLimit?: string; // default "64kb"
  log?: (message: string, error: unknown) => void; // unexpected (500) errors; default console.error
}

export const MIN_API_KEY_LENGTH = 16;

// An error the HTTP layer raises itself (as opposed to a PasswordManagerError from the library).
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<PasswordManagerErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNKNOWN_OWNER: 404,
  VAULT_ALREADY_EXISTS: 409,
  INVALID_MASTER_PASSWORD: 401,
  LOCKED_OUT: 423,
  UNKNOWN_ENTRY: 404,
  DECRYPTION_FAILED: 400,
  UNKNOWN_SESSION: 401,
  SESSION_INVALIDATED: 401,
  VAULT_BUSY: 409,
  ENTRY_CONFLICT: 409,
  STORE_TIMEOUT: 503,
  NO_SHARING_KEY: 409,
  UNKNOWN_SHARE: 404,
  SHARE_REVOKED: 410,
  SHARE_ALREADY_REDEEMED: 409,
  SESSION_IDLE_TIMEOUT: 401,
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

function isEncryptedBlobShape(value: unknown): value is { iv: string; ciphertext: string; authTag: string } {
  return isPlainObject(value) && typeof value.iv === "string" && typeof value.ciphertext === "string" && typeof value.authTag === "string";
}

// A structural check only -- whether the token actually opens with some vault's private key is for
// PasswordManager.redeemShare() to decide. Without this, a malformed body would reach openAsRecipient() as a
// plain TypeError (e.g. Buffer.from(undefined)) instead of a clean 400.
function isShareTokenShape(value: unknown): value is SharedEntryToken {
  return isPlainObject(value) && typeof value.shareId === "string" && typeof value.wrappedKey === "string" && isEncryptedBlobShape(value.blob);
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
  const { manager } = options;
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
  // Field-level type checking is deliberately NOT duplicated here: every PasswordManager method already
  // validates its own inputs (requireString, requireMasterPassword, ...) and throws INVALID_REQUEST (400) for
  // a wrong type or shape, so a field is simply read off the body and handed straight through.
  const bodyField = (req: Request, field: string): unknown => (isPlainObject(req.body) ? req.body[field] : undefined);

  app.post("/vaults", (req, res) => {
    requireJson(req);
    const summary = manager.createVault(bodyField(req, "ownerId") as string, bodyField(req, "masterPassword") as string);
    res.status(201).location(`/vaults/${encodeURIComponent(summary.ownerId)}`).json(summary);
  });

  app.get("/vaults/:ownerId", (req, res) => {
    res.json(manager.getVault(req.params.ownerId!));
  });

  app.post("/vaults/:ownerId/unlock", (req, res) => {
    requireJson(req);
    res.json(manager.unlock(req.params.ownerId!, bodyField(req, "masterPassword") as string));
  });

  app.post(
    "/vaults/:ownerId/rotate",
    asyncRoute(async (req, res) => {
      requireJson(req);
      await manager.changeMasterPassword(req.params.ownerId!, bodyField(req, "oldPassword") as string, bodyField(req, "newPassword") as string);
      res.status(204).end();
    }),
  );

  app.get("/vaults/:ownerId/export", (req, res) => {
    res.json(manager.exportVault(req.params.ownerId!));
  });

  app.post("/sessions/:sessionId/lock", (req, res) => {
    manager.lock(req.params.sessionId!);
    res.status(204).end();
  });

  app.get("/sessions/:sessionId", (req, res) => {
    res.json({ active: manager.isSessionActive(req.params.sessionId!) });
  });

  app.post(
    "/sessions/:sessionId/entries",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const input = (isPlainObject(req.body) ? req.body : {}) as unknown as EntryInput;
      const summary = await manager.addEntry(req.params.sessionId!, input);
      res
        .status(201)
        .location(`/sessions/${encodeURIComponent(req.params.sessionId!)}/entries/${encodeURIComponent(summary.id)}`)
        .json(summary);
    }),
  );

  app.get("/sessions/:sessionId/entries", (req, res) => {
    res.json(manager.listEntries(req.params.sessionId!));
  });

  app.get("/sessions/:sessionId/entries/:entryId", (req, res) => {
    res.json(manager.getEntry(req.params.sessionId!, req.params.entryId!));
  });

  app.patch(
    "/sessions/:sessionId/entries/:entryId",
    asyncRoute(async (req, res) => {
      requireJson(req);
      const patch = (isPlainObject(req.body) ? req.body : {}) as Partial<EntryInput>;
      res.json(await manager.updateEntry(req.params.sessionId!, req.params.entryId!, patch));
    }),
  );

  app.delete(
    "/sessions/:sessionId/entries/:entryId",
    asyncRoute(async (req, res) => {
      await manager.deleteEntry(req.params.sessionId!, req.params.entryId!);
      res.status(204).end();
    }),
  );

  app.get(
    "/sessions/:sessionId/sharing-key",
    asyncRoute(async (req, res) => {
      res.json({ publicKey: await manager.getSharingPublicKey(req.params.sessionId!) });
    }),
  );

  app.post("/sessions/:sessionId/entries/:entryId/share", (req, res) => {
    requireJson(req);
    const token = manager.shareEntry(req.params.sessionId!, req.params.entryId!, bodyField(req, "recipientPublicKey") as string);
    res.status(201).json(token);
  });

  app.post(
    "/sessions/:sessionId/shares/redeem",
    asyncRoute(async (req, res) => {
      requireJson(req);
      if (!isShareTokenShape(req.body)) throw new HttpError(400, "INVALID_REQUEST", "body must be a valid share token");
      res.status(201).json(await manager.redeemShare(req.params.sessionId!, req.body));
    }),
  );

  app.post("/sessions/:sessionId/shares/:shareId/revoke", (req, res) => {
    manager.revokeShare(req.params.sessionId!, req.params.shareId!);
    res.status(204).end();
  });

  app.post(
    "/breach-check",
    asyncRoute(async (req, res) => {
      requireJson(req);
      res.json({ breached: await manager.checkBreach(bodyField(req, "password") as string) });
    }),
  );

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
  if (error instanceof PasswordManagerError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    return { status, code: error.code, message: error.message };
  }
  // body-parser's own errors carry a `type`.
  const type = (error as { type?: unknown } | null)?.type;
  if (type === "entity.parse.failed") return { status: 400, code: "INVALID_JSON", message: "body is not valid JSON" };
  if (type === "entity.too.large") return { status: 413, code: "BODY_TOO_LARGE", message: "body is over the size limit" };
  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    return { status: 415, code: "UNSUPPORTED_ENCODING", message: "unsupported body encoding" };
  }
  log("password manager API: unexpected error", error);
  return { status: 500, code: "INTERNAL", message: "internal error" };
}
