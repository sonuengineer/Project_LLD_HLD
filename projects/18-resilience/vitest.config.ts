import { defineConfig } from "vitest/config";

// Several tests start real HTTP servers, an Express app or a Nest app. On a busy machine (seen: 100% CPU from other
// programs) booting Nest took longer than vitest's default 5 s hook timeout. The margins here only allow for a slow
// machine; no test waits on them when things are fast.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } });
