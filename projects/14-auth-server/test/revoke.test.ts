import { afterEach, describe, expect, it } from "vitest";
import { basic, closeAll, getCode, postForm, redeem, refresh, startServer, userinfo, WEB_SECRET } from "./helpers.js";

afterEach(closeAll);

async function tokens() {
  const s = await startServer();
  const { code, verifier } = await getCode(s.base);
  const tok = await redeem(s.base, code, verifier);
  return { s, rt: tok.body.refresh_token as string, at: tok.body.access_token as string };
}

describe("/revoke (RFC 7009)", () => {
  it("revoking a refresh token kills it and the access tokens of its family", async () => {
    const { s, rt, at } = await tokens();
    const r = await postForm(s.base, "/revoke", { token: rt, token_type_hint: "refresh_token", client_id: "spa" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await refresh(s.base, rt)).body.error).toBe("invalid_grant");
    expect((await userinfo(s.base, at)).status).toBe(401);
  });

  it("an unknown token -> 200 (RFC 7009 2.2), nothing changes", async () => {
    const { s, rt } = await tokens();
    expect((await postForm(s.base, "/revoke", { token: "unknown", client_id: "spa" })).status).toBe(200);
    expect((await refresh(s.base, rt)).status).toBe(200);
  });

  it("another client cannot revoke my token (200, but the token keeps working)", async () => {
    const { s, rt } = await tokens();
    expect((await postForm(s.base, "/revoke", { token: rt, client_id: "other-spa" })).status).toBe(200);
    expect((await postForm(s.base, "/revoke", { token: rt }, basic("web", WEB_SECRET))).status).toBe(200);
    expect((await refresh(s.base, rt)).status).toBe(200);
  });

  it("client authentication is required: wrong secret -> 401", async () => {
    const { s, rt } = await tokens();
    const r = await postForm(s.base, "/revoke", { token: rt }, basic("web", "wrong"));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
  });

  it("missing token -> 400 invalid_request", async () => {
    const { s } = await tokens();
    const r = await postForm(s.base, "/revoke", { client_id: "spa" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_request");
  });

  it("an access token is not revocable here (only refresh tokens): 200, and it keeps working", async () => {
    const { s, at } = await tokens();
    expect((await postForm(s.base, "/revoke", { token: at, token_type_hint: "access_token", client_id: "spa" })).status).toBe(200);
    expect((await userinfo(s.base, at)).status).toBe(200);
  });
});
