#!/usr/bin/env node
// CLI: CONFIG_FILE (required), ISSUER (default http://127.0.0.1:<PORT>), PORT (default 9000), HOST (default
// 127.0.0.1), SIGNING_KEY_FILE (optional PKCS#8 PEM, EC P-256; without it a fresh key is generated and every
// token becomes unverifiable after a restart).
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { generateSigningKey, signingKeyFromPem } from "./jwt.js";
import { createAuthServer } from "./server.js";

function main(): void {
  const configFile = process.env.CONFIG_FILE;
  if (!configFile) {
    console.error("CONFIG_FILE is required (see config/example.json)");
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? "9000");
  const host = process.env.HOST ?? "127.0.0.1";
  const issuer = process.env.ISSUER ?? `http://127.0.0.1:${port}`;
  const keyFile = process.env.SIGNING_KEY_FILE;
  const key = keyFile ? signingKeyFromPem(readFileSync(keyFile, "utf8")) : generateSigningKey();
  const server = createAuthServer({ issuer, config: loadConfig(configFile), keys: [key] });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ msg: "listening", issuer, host, port, kid: key.kid, keySource: keyFile ? "file" : "generated" }));
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
