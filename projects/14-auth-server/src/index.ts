#!/usr/bin/env node
// CLI: CONFIG_FILE (required), ISSUER (default http://127.0.0.1:<PORT>), PORT (default 9000), HOST (default
// 127.0.0.1).
// DATA_DIR (recommended): file-backed stores (store.jsonl) and rotating signing keys (keys.json, mode 0600) in
//   that directory; both survive a restart. KEY_ROTATE_DAYS (default 30) = age at which the active key rotates.
// Without DATA_DIR: in-memory stores, and SIGNING_KEY_FILE (optional PKCS#8 PEM, EC P-256) or a fresh key at
// every start, so every token becomes unverifiable after a restart.
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openFileStores } from "./file-store.js";
import { generateSigningKey, signingKeyFromPem } from "./jwt.js";
import { FileKeyRing, StaticKeyRing } from "./keys.js";
import type { KeyRing } from "./keys.js";
import { createAuthServer, DEFAULT_LIFETIMES, keyRetentionMs } from "./server.js";
import type { Stores } from "./store.js";

function main(): void {
  const configFile = process.env.CONFIG_FILE;
  if (!configFile) {
    console.error("CONFIG_FILE is required (see config/example.json)");
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? "9000");
  const host = process.env.HOST ?? "127.0.0.1";
  const issuer = process.env.ISSUER ?? `http://127.0.0.1:${port}`;
  const dataDir = process.env.DATA_DIR;
  let keyRing: KeyRing;
  let stores: Stores | undefined;
  let close = (): void => {};
  let keySource: string;
  if (dataDir) {
    const days = Number(process.env.KEY_ROTATE_DAYS ?? "30");
    keyRing = FileKeyRing.open(dataDir, { retainMs: keyRetentionMs(DEFAULT_LIFETIMES), rotateAfterMs: days * 24 * 3600 * 1000 });
    const fileStores = openFileStores(dataDir);
    stores = fileStores;
    close = () => fileStores.close();
    keySource = "data-dir";
    console.log(JSON.stringify({ msg: "store opened", dataDir, ...fileStores.info }));
  } else {
    const keyFile = process.env.SIGNING_KEY_FILE;
    keyRing = new StaticKeyRing([keyFile ? signingKeyFromPem(readFileSync(keyFile, "utf8")) : generateSigningKey()]);
    keySource = keyFile ? "file" : "generated";
  }
  const server = createAuthServer({ issuer, config: loadConfig(configFile), keyRing, stores });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ msg: "listening", issuer, host, port, kid: keyRing.signing(Date.now()).kid, keySource, storage: dataDir ? "file" : "memory" }));
  });
  const stop = (): void => {
    server.close(() => {
      close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
