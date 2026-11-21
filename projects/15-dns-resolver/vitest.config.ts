import { defineConfig } from "vitest/config";

// Test files run one after another: the resolver tests open many real UDP/TCP sockets on loopback and some use
// short timeouts, so running files in parallel on a busy machine would only add noise.
export default defineConfig({ test: { fileParallelism: false } });
