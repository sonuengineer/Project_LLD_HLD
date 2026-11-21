// File-backed stores: the in-memory stores from store.ts plus an append-only JSON-lines log on disk, using
// node:fs only. Every change is first written to the log and fsync'ed, THEN applied in memory, and the HTTP
// response is only sent after that. On start the log is replayed (the same `apply` function as the live path),
// then compacted: expired entries are dropped and the result is written to a temp file, fsync'ed and renamed
// over the log.
//
// Crash safety (what really happens):
// - Crash between two appends: the log holds every acknowledged change. A request that wrote some but not all
//   of its records (for example code consumed, family not yet created) fails closed: the code is burned and the
//   client got no tokens.
// - Crash in the middle of an append: the last line is torn (no trailing newline / not valid JSON). On replay a
//   torn LAST line is dropped (it was never acknowledged). A bad line anywhere else means corruption: the store
//   refuses to open instead of guessing.
// - Crash during compaction: the old log is untouched until the rename; a leftover temp file is overwritten at
//   the next start. rename() replaces the file atomically on POSIX file systems; on Windows node uses
//   MoveFileEx(REPLACE_EXISTING), which is not documented as atomic, and the directory fsync is not available.
// - fsync only helps if the disk honours it (no lying write caches). This was NOT tested with real power loss;
//   the tests simulate a torn line by writing one.
// - ONE process per data directory. There is no lock file: two processes would interleave writes and each would
//   only see its own changes in memory.
// - Login transactions (10-minute lifetime, they contain the raw CSRF token) are NOT persisted: after a restart
//   a user in the middle of the login form has to start again.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { MemoryCodeStore, MemorySessionStore, MemoryTokenStore, MemoryTransactionStore } from "./store.js";
import type {
  AuthorizationCode,
  CodeStore,
  ConsumeResult,
  LoginSession,
  RefreshToken,
  SessionStore,
  Stores,
  TokenFamily,
  TokenStore,
} from "./store.js";

export type LogRecord =
  | { op: "code.save"; code: AuthorizationCode }
  | { op: "code.used"; codeHash: string }
  | { op: "code.family"; codeHash: string; familyId: string }
  | { op: "family.create"; family: TokenFamily }
  | { op: "family.revoke"; id: string }
  | { op: "refresh.save"; token: RefreshToken }
  | { op: "refresh.used"; tokenHash: string }
  | { op: "access.record"; jti: string; familyId: string; expiresAt: number }
  | { op: "session.save"; session: LoginSession }
  | { op: "session.delete"; sid: string };

export class StoreCorruptError extends Error {}

export const LOG_FILE = "store.jsonl";

interface Mem {
  codes: MemoryCodeStore;
  tokens: MemoryTokenStore;
  sessions: MemorySessionStore;
}

/** Applies one record to the in-memory state. Used for live changes AND for replay, so both agree. */
function apply(mem: Mem, r: LogRecord): void {
  switch (r.op) {
    case "code.save":
      return mem.codes.save(r.code);
    case "code.used":
      mem.codes.consume(r.codeHash);
      return;
    case "code.family":
      return mem.codes.setFamily(r.codeHash, r.familyId);
    case "family.create":
      return mem.tokens.createFamily(r.family);
    case "family.revoke":
      return mem.tokens.revokeFamily(r.id);
    case "refresh.save":
      return mem.tokens.saveRefresh(r.token);
    case "refresh.used":
      mem.tokens.markUsed(r.tokenHash);
      return;
    case "access.record":
      return mem.tokens.recordAccessToken(r.jti, r.familyId, r.expiresAt);
    case "session.save":
      return mem.sessions.save(r.session);
    case "session.delete":
      return mem.sessions.delete(r.sid);
    default:
      throw new StoreCorruptError(`unknown log record ${JSON.stringify(r)}`);
  }
}

function fsyncDir(dir: string): void {
  // Makes the rename itself durable on POSIX. Windows cannot open a directory for fsync; skip there.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported on this platform */
  }
}

/** Live state -> the smallest list of records that recreates it, dropping everything expired at `now`. */
function snapshot(mem: Mem, now: number): LogRecord[] {
  const out: LogRecord[] = [];
  const neededFamilies = new Set<string>();
  const codes = mem.codes.entries().filter((e) => e.code.expiresAt > now);
  const refresh = mem.tokens.allRefresh().filter((t) => t.expiresAt > now);
  const access = mem.tokens.allAccess().filter((a) => a.expiresAt > now);
  for (const e of codes) if (e.code.familyId) neededFamilies.add(e.code.familyId);
  for (const t of refresh) neededFamilies.add(t.familyId);
  for (const a of access) neededFamilies.add(a.familyId);
  for (const f of mem.tokens.allFamilies()) if (neededFamilies.has(f.id)) out.push({ op: "family.create", family: f });
  for (const e of codes) {
    out.push({ op: "code.save", code: e.code });
    if (e.used) out.push({ op: "code.used", codeHash: e.code.codeHash });
  }
  for (const t of refresh) out.push({ op: "refresh.save", token: t });
  for (const a of access) out.push({ op: "access.record", jti: a.jti, familyId: a.familyId, expiresAt: a.expiresAt });
  for (const s of mem.sessions.all()) if (s.expiresAt > now) out.push({ op: "session.save", session: s });
  return out;
}

export interface OpenInfo {
  /** Records replayed from the log. */
  replayed: number;
  /** true if a torn last line (an unacknowledged write) was dropped. */
  droppedTornLine: boolean;
  /** Records written by the compaction. */
  compacted: number;
}

export interface FileStores extends Stores {
  readonly info: OpenInfo;
  close(): void;
}

function readLog(path: string, mem: Mem): { replayed: number; droppedTornLine: boolean } {
  if (!existsSync(path)) return { replayed: 0, droppedTornLine: false };
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  // A complete log ends with "\n", so the final element is "". Anything else there is a torn write.
  const tail = lines.pop() ?? "";
  let replayed = 0;
  for (const [i, line] of lines.entries()) {
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      throw new StoreCorruptError(`${path}: line ${i + 1} is not valid JSON; refusing to start`);
    }
    apply(mem, rec);
    replayed++;
  }
  return { replayed, droppedTornLine: tail !== "" };
}

/**
 * Opens (or creates) the stores in `dir`. `now` decides what is expired during compaction.
 * `fsync: false` is for tests that do not care about durability; the default is true.
 */
export function openFileStores(dir: string, opts: { now?: () => number; fsync?: boolean } = {}): FileStores {
  const now = opts.now ?? Date.now;
  const doFsync = opts.fsync ?? true;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOG_FILE);
  const mem: Mem = { codes: new MemoryCodeStore(), tokens: new MemoryTokenStore(), sessions: new MemorySessionStore() };
  const { replayed, droppedTornLine } = readLog(path, mem);

  // Compaction: write the live state to a temp file, make it durable, then swap it in.
  const records = snapshot(mem, now());
  const tmp = `${path}.tmp`;
  const tfd = openSync(tmp, "w", 0o600);
  try {
    writeSync(tfd, records.map((r) => JSON.stringify(r) + "\n").join(""));
    if (doFsync) fsyncSync(tfd);
  } finally {
    closeSync(tfd);
  }
  renameSync(tmp, path);
  if (doFsync) fsyncDir(dir);
  // Replay the compacted state into fresh memory so expired entries are really gone.
  const live: Mem = { codes: new MemoryCodeStore(), tokens: new MemoryTokenStore(), sessions: new MemorySessionStore() };
  for (const r of records) apply(live, r);

  let fd: number | undefined = openSync(path, "a", 0o600);
  /** Appends and fsyncs. Throws if the store is closed or the disk write fails. */
  const durable = (data: string): void => {
    if (fd === undefined) throw new Error("file store is closed");
    writeSync(fd, data);
    if (doFsync) fsyncSync(fd);
  };
  const commit = (...recs: LogRecord[]): void => {
    // Write-ahead: durable on disk first, then visible in memory. If the write throws, memory is unchanged.
    durable(recs.map((r) => JSON.stringify(r) + "\n").join(""));
    for (const r of recs) apply(live, r);
  };

  const codes: CodeStore = {
    save: (code) => commit({ op: "code.save", code }),
    consume(codeHash): ConsumeResult {
      // Decide from memory, log, then apply: all synchronous, so no other request runs in between.
      const e = live.codes.peek(codeHash);
      if (!e) return { kind: "missing" };
      if (e.used) return { kind: "reused", code: e.code };
      commit({ op: "code.used", codeHash });
      return { kind: "ok", code: e.code };
    },
    setFamily: (codeHash, familyId) => commit({ op: "code.family", codeHash, familyId }),
  };

  const tokens: TokenStore = {
    createFamily: (family) => commit({ op: "family.create", family }),
    getFamily: (id) => live.tokens.getFamily(id),
    revokeFamily(id) {
      const f = live.tokens.getFamily(id);
      if (f && !f.revoked) commit({ op: "family.revoke", id });
    },
    familiesOfSession: (sid) => live.tokens.familiesOfSession(sid),
    saveRefresh: (token) => commit({ op: "refresh.save", token }),
    getRefresh: (h) => live.tokens.getRefresh(h),
    markUsed(tokenHash) {
      const t = live.tokens.getRefresh(tokenHash);
      if (!t || t.used) return false;
      commit({ op: "refresh.used", tokenHash });
      return true;
    },
    recordAccessToken: (jti, familyId, expiresAt) => commit({ op: "access.record", jti, familyId, expiresAt }),
    familyOfAccessToken: (jti) => live.tokens.familyOfAccessToken(jti),
  };

  const sessions: SessionStore = {
    save: (session) => commit({ op: "session.save", session }),
    get: (sid) => live.sessions.get(sid),
    getByCookie: (h) => live.sessions.getByCookie(h),
    delete(sid) {
      if (live.sessions.get(sid)) commit({ op: "session.delete", sid });
    },
  };

  return {
    transactions: new MemoryTransactionStore(),
    codes,
    tokens,
    sessions,
    info: { replayed, droppedTornLine, compacted: records.length },
    close() {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
    },
  };
}
