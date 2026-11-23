import { defineConfig } from "vitest/config";

// Redis tests talk to a real server; generous timeouts so a busy machine does not make them flaky (lesson from
// projects/18-resilience). Files run one after another: the Redis tests share one server and flush their own prefix.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000, fileParallelism: false } });
