import { afterEach, describe, expect, it } from "vitest";
import { generateSigningKey, signJwt } from "../src/jwt.js";
import { closeAll, decodeJwt, getCode, redeem, startServer, userinfo } from "./helpers.js";

afterEach(closeAll);

async function tokens(scope = "openid profile email") {
  const s = await startServer();
  const { code, verifier } = await getCode(s.base, { scope });
  const tok = await redeem(s.base, code, verifier);
  expect(tok.status).toBe(200);
  return { s, at: tok.body.access_token as string, idToken: tok.body.id_token as string | undefined };
}

function flipLastSignatureChar(jwt: string): string {
  const last = jwt.at(-2) === "A" ? "B" : "A";
  return jwt.slice(0, -2) + last + jwt.slice(-1);
}

describe("/userinfo", () => {
  it("no Authorization header -> 401 with a bare Bearer challenge", async () => {
    const { s } = await tokens();
    const r = await fetch(`${s.base}/userinfo`);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("tampered signature -> 401 invalid_token", async () => {
    const { s, at } = await tokens();
    const r = await userinfo(s.base, flipLastSignatureChar(at));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_token");
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("tampered payload (sub changed, signature kept) -> 401", async () => {
    const { s, at } = await tokens();
    const [h, , sig] = at.split(".");
    const payload = { ...decodeJwt(at).payload, sub: "user-0002" };
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect((await userinfo(s.base, forged)).status).toBe(401);
  });

  it("a token signed by a different key with the same kid -> 401", async () => {
    const { s, at } = await tokens();
    const other = generateSigningKey();
    const forged = signJwt({ ...other, kid: s.keys[0]?.kid ?? "" }, "at+jwt", decodeJwt(at).payload);
    expect((await userinfo(s.base, forged)).status).toBe(401);
  });

  it("alg none -> 401", async () => {
    const { s, at } = await tokens();
    const { header, payload } = decodeJwt(at);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    expect((await userinfo(s.base, `${enc({ ...header, alg: "none" })}.${enc(payload)}.`)).status).toBe(401);
  });

  it("the id_token presented as an access token (wrong audience and typ) -> 401", async () => {
    const { s, idToken } = await tokens();
    const r = await userinfo(s.base, idToken ?? "");
    expect(r.status).toBe(401);
  });

  it("a correctly signed token with the wrong audience -> 401 'wrong audience'", async () => {
    const { s, at } = await tokens();
    const forged = signJwt(s.keys[0]!, "at+jwt", { ...decodeJwt(at).payload, aud: "https://other-api.example.test" });
    const r = await userinfo(s.base, forged);
    expect(r.status).toBe(401);
    expect(r.body.error_description).toBe("wrong audience");
  });

  it("a correctly signed token from another issuer -> 401 'wrong issuer'", async () => {
    const { s, at } = await tokens();
    const forged = signJwt(s.keys[0]!, "at+jwt", { ...decodeJwt(at).payload, iss: "https://evil.example.test" });
    expect((await userinfo(s.base, forged)).body.error_description).toBe("wrong issuer");
  });

  it("an expired access token -> 401 'expired'", async () => {
    const { s, at } = await tokens();
    s.clock.t += 300_000;
    const r = await userinfo(s.base, at);
    expect(r.status).toBe(401);
    expect(r.body.error_description).toBe("expired");
  });

  it("an access token without the openid scope -> 403 insufficient_scope", async () => {
    const { s, at } = await tokens("profile");
    const r = await userinfo(s.base, at);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("insufficient_scope");
  });

  it("a token this server never recorded (no known jti) -> 401", async () => {
    const { s, at } = await tokens();
    const forged = signJwt(s.keys[0]!, "at+jwt", { ...decodeJwt(at).payload, jti: "never-issued" });
    expect((await userinfo(s.base, forged)).status).toBe(401);
  });

  it("responses are no-store", async () => {
    const { s, at } = await tokens();
    expect((await userinfo(s.base, at)).headers.get("cache-control")).toBe("no-store");
  });
});
