// File-backed storage (src/file-store.ts) and signing keys on disk: the server is stopped and started again on
// the SAME data directory (and the same port, so the issuer is unchanged), and everything issued before the
// restart must still behave correctly after it.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOG_FILE, openFileStores, StoreCorruptError } from "../src/file-store.js";
import type { FileStores } from "../src/file-store.js";
import { FileKeyRing } from "../src/keys.js";
import { sha256 } from "../src/secrets.js";
import { DEFAULT_LIFETIMES, keyRetentionMs } from "../src/server.js";
import { closeAll, getCode, openLogin, authorizeParams, pkce, postForm, postLogin, redeem, refresh, startServer, userinfo, ALICE } from "./helpers.js";
import type { TestServer } from "./helpers.js";

const dirs: string[] = [];
const opened: FileStores[] = [];

afterEach(async () => {
  await closeAll();
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "auth-store-"));
  dirs.push(d);
  return d;
}

/** One "process": file stores + key ring opened from `dir`, HTTP server on `port` (0 = pick one). */
async function boot(dir: string, clock: { t: number }, port = 0): Promise<{ s: TestServer; stores: FileStores }> {
  const now = () => clock.t;
  const stores = openFileStores(dir, { now });
  opened.push(stores);
  const keyRing = FileKeyRing.open(dir, { retainMs: keyRetentionMs(DEFAULT_LIFETIMES), now });
  const s = await startServer({ stores, keyRing }, { port, clock });
  return { s, stores };
}

async function restart(dir: string, prev: { s: TestServer; stores: FileStores }): Promise<{ s: TestServer; stores: FileStores }> {
  await prev.s.close();
  prev.stores.close();
  // Let fetch's connection pool see that the old sockets are gone before the next request (otherwise it may
  // reuse a dead keep-alive socket and get ECONNRESET).
  await new Promise((r) => setTimeout(r, 50));
  return boot(dir, prev.s.clock, prev.s.port);
}

describe("file-backed store survives a restart", () => {
  it("access token, refresh token and signing key all work after a restart on the same data dir", async () => {
    const dir = tempDir();
    const first = await boot(dir, { t: Date.now() });
    const { code, verifier } = await getCode(first.s.base);
    const tok = await redeem(first.s.base, code, verifier);
    expect(tok.status).toBe(200);
    const jwksBefore = await (await fetch(`${first.s.base}/jwks`)).json();

    const second = await restart(dir, first);
    expect(second.stores.info.replayed).toBeGreaterThan(0);
    expect(await (await fetch(`${second.s.base}/jwks`)).json()).toEqual(jwksBefore);
    expect((await userinfo(second.s.base, tok.body.access_token as string)).status).toBe(200);
    const r = await refresh(second.s.base, tok.body.refresh_token as string);
    expect(r.status).toBe(200);
    expect((await userinfo(second.s.base, r.body.access_token as string)).status).toBe(200);
  });

  it("a refresh token used BEFORE the restart is still detected as reuse AFTER it, and the family dies", async () => {
    const dir = tempDir();
    const first = await boot(dir, { t: Date.now() });
    const { code, verifier } = await getCode(first.s.base);
    const tok = await redeem(first.s.base, code, verifier);
    const r1 = await refresh(first.s.base, tok.body.refresh_token as string);
    expect(r1.status).toBe(200);

    const second = await restart(dir, first);
    const reuse = await refresh(second.s.base, tok.body.refresh_token as string);
    expect(reuse.status).toBe(400);
    expect(String(reuse.body.error_description)).toContain("reuse");
    expect((await refresh(second.s.base, r1.body.refresh_token as string)).body.error).toBe("invalid_grant");

    // ...and that revocation is itself persisted.
    const third = await restart(dir, second);
    expect((await userinfo(third.s.base, r1.body.access_token as string)).status).toBe(401);
  });

  it("an authorization code redeemed before the restart is still single-use after it (and its reuse revokes)", async () => {
    const dir = tempDir();
    const first = await boot(dir, { t: Date.now() });
    const { code, verifier } = await getCode(first.s.base);
    const tok = await redeem(first.s.base, code, verifier);
    expect(tok.status).toBe(200);

    const second = await restart(dir, first);
    const again = await redeem(second.s.base, code, verifier);
    expect(again.status).toBe(400);
    expect(String(again.body.error_description)).toContain("already used");
    expect((await refresh(second.s.base, tok.body.refresh_token as string)).body.error).toBe("invalid_grant");
  });

  it("a revoked token family stays revoked after a restart", async () => {
    const dir = tempDir();
    const first = await boot(dir, { t: Date.now() });
    const { code, verifier } = await getCode(first.s.base);
    const tok = await redeem(first.s.base, code, verifier);
    expect((await postForm(first.s.base, "/revoke", { token: tok.body.refresh_token as string, client_id: "spa" })).status).toBe(200);

    const second = await restart(dir, first);
    expect((await refresh(second.s.base, tok.body.refresh_token as string)).body.error).toBe("invalid_grant");
    expect((await userinfo(second.s.base, tok.body.access_token as string)).status).toBe(401);
  });

  it("the log holds only hashes of codes, refresh tokens and session cookies, never the raw values", async () => {
    const dir = tempDir();
    const { s } = await boot(dir, { t: Date.now() });
    const { code, verifier, sessionCookie } = await getCode(s.base);
    const tok = await redeem(s.base, code, verifier);
    const rt = tok.body.refresh_token as string;
    const cookieValue = sessionCookie.split("=")[1] ?? "";
    expect(cookieValue.length).toBeGreaterThan(20);
    const log = readFileSync(join(dir, LOG_FILE), "utf8");
    for (const secret of [code, rt, cookieValue]) {
      expect(log).not.toContain(secret);
      expect(log).toContain(sha256(secret));
    }
  });

  it("login transactions are NOT persisted: a login form opened before a restart has to start again", async () => {
    const dir = tempDir();
    const first = await boot(dir, { t: Date.now() });
    const page = await openLogin(first.s.base, authorizeParams(pkce().challenge));
    expect(page.status).toBe(200);
    const second = await restart(dir, first);
    const r = await postLogin(second.s.base, page.cookie, { csrf_token: page.csrf, username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Login expired");
  });
});

describe("file store: crash safety and compaction", () => {
  function seed(dir: string, now: number): { codeHash: string; tokenHash: string } {
    const st = openFileStores(dir, { now: () => now, fsync: false });
    const codeHash = sha256("code-1");
    const tokenHash = sha256("refresh-1");
    st.codes.save({ codeHash, clientId: "spa", redirectUri: "x", sub: "u", scope: ["openid"], codeChallenge: "c", authTime: 1, expiresAt: now + 60_000 });
    st.tokens.createFamily({ id: "fam-1", clientId: "spa", sub: "u", scope: ["openid"], authTime: 1, revoked: false });
    st.tokens.saveRefresh({ tokenHash, familyId: "fam-1", clientId: "spa", expiresAt: now + 3_600_000, used: false });
    expect(st.codes.consume(codeHash).kind).toBe("ok");
    st.close();
    return { codeHash, tokenHash };
  }

  it("a torn LAST line (crash in the middle of an append) is dropped; everything before it is kept", () => {
    const dir = tempDir();
    const now = Date.now();
    const { codeHash, tokenHash } = seed(dir, now);
    appendFileSync(join(dir, LOG_FILE), '{"op":"refresh.used","tokenHa');
    const st = openFileStores(dir, { now: () => now, fsync: false });
    opened.push(st);
    expect(st.info.droppedTornLine).toBe(true);
    expect(st.codes.consume(codeHash).kind).toBe("reused");
    // The torn record never took effect: the refresh token is still unused.
    expect(st.tokens.getRefresh(tokenHash)?.used).toBe(false);
    // Compaction rewrote the file without the torn line.
    expect(readFileSync(join(dir, LOG_FILE), "utf8").endsWith("\n")).toBe(true);
  });

  it("a bad line in the MIDDLE of the log is corruption: the store refuses to open", () => {
    const dir = tempDir();
    seed(dir, Date.now());
    const path = join(dir, LOG_FILE);
    const lines = readFileSync(path, "utf8").split("\n");
    lines.splice(1, 0, "this is not json");
    writeFileSync(path, lines.join("\n"));
    expect(() => openFileStores(dir, { fsync: false })).toThrow(StoreCorruptError);
  });

  it("write-ahead: when the disk write fails, the in-memory state does not change", () => {
    const dir = tempDir();
    const now = Date.now();
    const { tokenHash } = seed(dir, now);
    const st = openFileStores(dir, { now: () => now, fsync: false });
    st.close(); // every later write throws, like a full disk
    expect(() => st.tokens.markUsed(tokenHash)).toThrow();
    expect(st.tokens.getRefresh(tokenHash)?.used).toBe(false);
  });

  it("compaction at start drops expired codes and refresh tokens (and families nothing refers to)", () => {
    const dir = tempDir();
    const now = Date.now();
    const { codeHash, tokenHash } = seed(dir, now);
    const later = now + 2 * 3_600_000; // past the code (60 s) and the refresh token (1 h)
    const st = openFileStores(dir, { now: () => later, fsync: false });
    opened.push(st);
    expect(st.info.replayed).toBe(4);
    expect(st.info.compacted).toBe(0);
    expect(st.tokens.getRefresh(tokenHash)).toBeUndefined();
    expect(st.tokens.getFamily("fam-1")).toBeUndefined();
    expect(st.codes.consume(codeHash).kind).toBe("missing");
    expect(readFileSync(join(dir, LOG_FILE), "utf8")).toBe("");
  });

  it("compaction keeps live entries with their state (used, revoked)", () => {
    const dir = tempDir();
    const now = Date.now();
    const { codeHash, tokenHash } = seed(dir, now);
    const st1 = openFileStores(dir, { now: () => now, fsync: false });
    st1.tokens.revokeFamily("fam-1");
    st1.close();
    const st2 = openFileStores(dir, { now: () => now, fsync: false });
    opened.push(st2);
    expect(st2.codes.consume(codeHash).kind).toBe("reused");
    expect(st2.tokens.getFamily("fam-1")?.revoked).toBe(true);
    expect(st2.tokens.getRefresh(tokenHash)?.used).toBe(false);
  });
});
