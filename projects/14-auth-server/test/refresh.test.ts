import { afterEach, describe, expect, it } from "vitest";
import { closeAll, decodeJwt, getCode, postForm, redeem, refresh, startServer, userinfo } from "./helpers.js";

afterEach(closeAll);

async function tokens() {
  const s = await startServer();
  const { code, verifier } = await getCode(s.base);
  const tok = await redeem(s.base, code, verifier);
  expect(tok.status).toBe(200);
  return { s, rt: tok.body.refresh_token as string, at: tok.body.access_token as string };
}

describe("refresh tokens: rotation and reuse detection", () => {
  it("every use returns a NEW refresh token; the old one stops working", async () => {
    const { s, rt } = await tokens();
    const r1 = await refresh(s.base, rt);
    expect(r1.status).toBe(200);
    const r2 = await refresh(s.base, r1.body.refresh_token as string);
    expect(r2.status).toBe(200);
    expect(new Set([rt, r1.body.refresh_token, r2.body.refresh_token]).size).toBe(3);
  });

  it("reusing an old refresh token revokes the WHOLE family, including the newest token", async () => {
    const { s, rt, at } = await tokens();
    const r1 = await refresh(s.base, rt);
    const newest = r1.body.refresh_token as string;

    const reuse = await refresh(s.base, rt);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    expect(String(reuse.body.error_description)).toContain("reuse");

    const afterwards = await refresh(s.base, newest);
    expect(afterwards.status).toBe(400);
    expect(afterwards.body.error).toBe("invalid_grant");
    expect((await userinfo(s.base, r1.body.access_token as string)).status).toBe(401);
    expect((await userinfo(s.base, at)).status).toBe(401);
  });

  it("a refresh token of another client -> invalid_grant and the family is NOT revoked", async () => {
    const { s, rt } = await tokens();
    const r = await refresh(s.base, rt, { client_id: "other-spa" });
    expect(r.body.error).toBe("invalid_grant");
    expect((await refresh(s.base, rt)).status).toBe(200);
  });

  it("an unknown refresh token -> invalid_grant", async () => {
    const { s } = await tokens();
    expect((await refresh(s.base, "made-up")).body.error).toBe("invalid_grant");
  });

  it("an expired refresh token -> invalid_grant", async () => {
    const { s, rt } = await tokens();
    s.clock.t += 14 * 24 * 3600 * 1000;
    expect((await refresh(s.base, rt)).body.error).toBe("invalid_grant");
  });

  it("scope can be narrowed but not widened; a refused scope request does not burn the token", async () => {
    const { s, rt } = await tokens();
    const wider = await refresh(s.base, rt, { scope: "openid profile email offline_access" });
    expect(wider.status).toBe(400);
    expect(wider.body.error).toBe("invalid_scope");
    const narrow = await refresh(s.base, rt, { scope: "openid" });
    expect(narrow.status).toBe(200);
    expect(narrow.body.scope).toBe("openid");
    expect(decodeJwt(narrow.body.access_token as string).payload.scope).toBe("openid");
    // The refresh token keeps the ORIGINAL grant (RFC 6749 section 6).
    const again = await refresh(s.base, narrow.body.refresh_token as string);
    expect(again.body.scope).toBe("openid profile email");
  });

  it("missing refresh_token parameter -> invalid_request", async () => {
    const { s } = await tokens();
    const r = await postForm(s.base, "/token", { grant_type: "refresh_token", client_id: "spa" });
    expect(r.body.error).toBe("invalid_request");
  });
});
