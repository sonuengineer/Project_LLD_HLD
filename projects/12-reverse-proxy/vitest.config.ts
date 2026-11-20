import { defineConfig } from "vitest/config";

// Test files run one after another. The helper that makes a "dead" port frees a port and then
// expects nothing to take it; files running in parallel could be handed that same port.
export default defineConfig({ test: { fileParallelism: false } });
