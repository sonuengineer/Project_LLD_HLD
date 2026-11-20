import { defineConfig } from "vitest/config";

// Test files run one after another. The helper that makes a "dead" port frees a port and then
// expects nothing to take it; files running in parallel could be handed that same port.
// globalSetup builds dist/ because test/shutdown.test.ts starts the real CLI process.
export default defineConfig({ test: { fileParallelism: false, globalSetup: ["./test/global-setup.ts"] } });
