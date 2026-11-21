import { afterEach, describe, expect, it } from "vitest";
import { generateSigningKey, jwkThumbprint } from "../src/jwt.js";
import { closeAll, startServer } from "./helpers.js";

afterEach(closeAll);

describe("discovery and JWKS", () => {
  it("/.well-known/openid-configuration describes exactly what is implemented", async () => {
    const s = await startServer();
    const r = await fetch(`${s.base}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as Record<string, unknown>;
    expect(d).toMatchObject({
      issuer: s.base,
      authorization_endpoint: `${s.base}/authorize`,
      token_endpoint: `${s.base}/token`,
      userinfo_endpoint: `${s.base}/userinfo`,
      jwks_uri: `${s.base}/jwks`,
      revocation_endpoint: `${s.base}/revoke`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["ES256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    });
  });

  it("/jwks publishes every key as a public EC JWK with kid = RFC 7638 thumbprint, no private part", async () => {
    const keys = [generateSigningKey(), generateSigningKey()];
    const s = await startServer({ keys });
    const body = (await (await fetch(`${s.base}/jwks`)).json()) as { keys: Record<string, string>[] };
    expect(body.keys).toHaveLength(2);
    for (const [i, jwk] of body.keys.entries()) {
      expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: keys[i]?.kid });
      expect(jwk.d).toBeUndefined();
      expect(jwk.kid).toBe(jwkThumbprint({ crv: "P-256", kty: "EC", x: jwk.x ?? "", y: jwk.y ?? "" }));
    }
  });

  it("unknown path -> 404 JSON", async () => {
    const s = await startServer();
    expect((await fetch(`${s.base}/nope`)).status).toBe(404);
  });
});
