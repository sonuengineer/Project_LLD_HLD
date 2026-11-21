#!/usr/bin/env node
// Prints the scrypt hash of a password or client secret for the config file.
// Usage: node dist/hash-secret.js <secret>   (the secret ends up in your shell history; fine for test values)
import { hashSecret } from "./secrets.js";

const secret = process.argv[2];
if (!secret) {
  console.error("usage: node dist/hash-secret.js <secret>");
  process.exit(2);
}
console.log(await hashSecret(secret));
