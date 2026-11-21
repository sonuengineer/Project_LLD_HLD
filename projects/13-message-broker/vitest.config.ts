import { defineConfig } from "vitest/config";

// Test files run one after another: the integration tests open real TCP sockets and some use short timers,
// so running them in parallel on a busy machine would only add noise.
export default defineConfig({ test: { fileParallelism: false } });
