import { defineConfig } from "vitest/config";

// Almost every test uses an injected clock or fake timers. The few that use real time (a real setInterval sweep)
// wait on events, not on tight margins. The wide timeouts only allow for a busy machine (seen in projects/18: 100% CPU
// from other programs); no test waits on them when things are fast.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } });
