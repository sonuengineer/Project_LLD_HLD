// Signing-key rotation with overlap (src/keys.ts FileKeyRing) and private keys on disk.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileKeyRing, KEYS_FILE } from "../src/keys.js";
import { DEFAULT_LIFETIMES, keyRetentionMs } from "../src/server.js";
import { closeAll, decodeJwt, getCode, redeem, startServer, userinfo } from "./helpers.js";

const RETAIN = keyRetentionMs(DEFAULT_LIFETIMES);
const dirs: string[] = [];

afterEach(async () => {
  await closeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "auth-keys-"));
  dirs.push(d);
  return d;
}

async function serverWithRing(opts: { rotateAfterMs?: number } = {}) {
  const dir = tempDir();
  const clock = { t: Date.now() };
  const ring = FileKeyRing.open(dir, { retainMs: RETAIN, now: () => clock.t, ...opts });
  const s = await startServer({ keyRing: ring }, { clock });
  const jwksKids = async (): Promise<string[]> => ((await (await fetch(`${s.base}/jwks`)).json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
  const issue = async (): Promise<{ at: string; id: string }> => {
    const { code, verifier } = await getCode(s.base);
    const tok = await redeem(s.base, code, verifier);
    expect(tok.status).toBe(200);
    return { at: tok.body.access_token as string, id: tok.body.id_token as string };
  };
  return { dir, clock, ring, s, jwksKids, issue };
}

const kidOf = (jwt: string): string => decodeJwt(jwt).header.kid as string;

describe("signing keys on disk", () => {
  it("first start generates an active and a pre-published next key; both are in /jwks, only the active one signs", async () => {
    const { ring, jwksKids, issue } = await serverWithRing();
    const states = ring.describe();
    expect(states.map((k) => k.state).sort()).toEqual(["active", "next"]);
    const active = states.find((k) => k.state === "active")?.kid;
    const next = states.find((k) => k.state === "next")?.kid;
    expect(await jwksKids()).toEqual([active, next]);
    const { at, id } = await issue();
    expect(kidOf(at)).toBe(active);
    expect(kidOf(id)).toBe(active);
  });

  it("the keys are read back from the data dir at the next start (same kids)", async () => {
    const dir = tempDir();
    const a = FileKeyRing.open(dir, { retainMs: RETAIN });
    const b = FileKeyRing.open(dir, { retainMs: RETAIN });
    expect(b.describe()).toEqual(a.describe());
    expect(b.signing(Date.now()).kid).toBe(a.signing(Date.now()).kid);
  });

  it.skipIf(process.platform === "win32")("keys.json is created with mode 0600 (owner only)", () => {
    const dir = tempDir();
    FileKeyRing.open(dir, { retainMs: RETAIN });
    expect(statSync(join(dir, KEYS_FILE)).mode & 0o777).toBe(0o600);
  });

  it("keys.json holds PKCS#8 private keys; /jwks never exposes the private part", async () => {
    const { dir, s } = await serverWithRing();
    expect(readFileSync(join(dir, KEYS_FILE), "utf8")).toContain("BEGIN PRIVATE KEY");
    const body = (await (await fetch(`${s.base}/jwks`)).json()) as { keys: Record<string, unknown>[] };
    for (const k of body.keys) expect(k.d).toBeUndefined();
  });

  it("a file with two active keys, or a kid that does not match its key, is refused", () => {
    const dir = tempDir();
    FileKeyRing.open(dir, { retainMs: RETAIN });
    const path = join(dir, KEYS_FILE);
    const good = JSON.parse(readFileSync(path, "utf8")) as { keys: { kid: string; activatedAt: number | null }[] };
    const twoActive = structuredClone(good);
    for (const k of twoActive.keys) k.activatedAt = 1;
    writeFileSync(path, JSON.stringify(twoActive));
    expect(() => FileKeyRing.open(dir, { retainMs: RETAIN })).toThrow(/exactly one active/);
    const badKid = structuredClone(good);
    (badKid.keys[0] as { kid: string }).kid = "not-the-thumbprint";
    writeFileSync(path, JSON.stringify(badKid));
    expect(() => FileKeyRing.open(dir, { retainMs: RETAIN })).toThrow(/does not match/);
  });
});

describe("rotation with overlap", () => {
  it("rotate(): the pre-published key starts signing, the old key stays published, a new next key appears", async () => {
    const { s, ring, clock, jwksKids, issue } = await serverWithRing();
    const oldActive = ring.signing(clock.t).kid;
    const oldNext = ring.describe().find((k) => k.state === "next")?.kid;
    const before = await issue();

    ring.rotate(clock.t);
    const after = await issue();
    expect(kidOf(after.at)).toBe(oldNext);
    expect(kidOf(after.id)).toBe(oldNext);
    const kids = await jwksKids();
    expect(kids).toHaveLength(3);
    expect(kids[0]).toBe(oldNext);
    expect(kids).toContain(oldActive);
    // A token signed by the retired key is still accepted by our own /userinfo, and so is the new one.
    expect((await userinfo(s.base, before.at)).status).toBe(200);
    expect((await userinfo(s.base, after.at)).status).toBe(200);
  });

  it("the retired key stays published until its last token has expired, then disappears", async () => {
    const { s, ring, clock, jwksKids, issue } = await serverWithRing();
    const oldKid = ring.signing(clock.t).kid;
    const before = await issue();
    ring.rotate(clock.t);

    clock.t += RETAIN - 1000; // 1 s before the last token signed by the old key expires
    expect(await jwksKids()).toContain(oldKid);
    expect((await userinfo(s.base, before.at)).status).toBe(200);

    clock.t += 1000; // that token has now expired, so the key is no longer needed
    expect(await jwksKids()).not.toContain(oldKid);
    expect((await userinfo(s.base, before.at)).status).toBe(401);
  });

  it("the retention is the longest token lifetime the key could have signed", () => {
    expect(keyRetentionMs(DEFAULT_LIFETIMES)).toBe(300_000);
    expect(keyRetentionMs({ ...DEFAULT_LIFETIMES, idToken: 900 })).toBe(900_000);
  });

  it("automatic rotation once the active key is older than rotateAfterMs", async () => {
    const { ring, clock, issue } = await serverWithRing({ rotateAfterMs: 3_600_000 });
    const first = ring.signing(clock.t).kid;
    clock.t += 3_600_000 - 1;
    expect(kidOf((await issue()).at)).toBe(first);
    clock.t += 1;
    const t = await issue();
    expect(kidOf(t.at)).not.toBe(first);
    expect(ring.describe().find((k) => k.kid === first)?.state).toBe("retired");
  });

  it("a rotation is written to keys.json, so a restart keeps the retired key published and signs with the new one", async () => {
    const dir = tempDir();
    const now = Date.now();
    const a = FileKeyRing.open(dir, { retainMs: RETAIN, now: () => now });
    const oldKid = a.signing(now).kid;
    a.rotate(now);
    const b = FileKeyRing.open(dir, { retainMs: RETAIN, now: () => now });
    expect(b.signing(now).kid).toBe(a.signing(now).kid);
    expect(b.published(now).map((k) => k.kid)).toContain(oldKid);
  });

  it("expired retired keys are removed from keys.json at the next rotation", () => {
    const dir = tempDir();
    const now = Date.now();
    const ring = FileKeyRing.open(dir, { retainMs: RETAIN, now: () => now });
    const first = ring.signing(now).kid;
    ring.rotate(now);
    ring.rotate(now + RETAIN);
    const inFile = (JSON.parse(readFileSync(join(dir, KEYS_FILE), "utf8")) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
    expect(inFile).not.toContain(first);
    expect(inFile).toHaveLength(3); // retired (second), active (third), next (fourth)
  });
});
