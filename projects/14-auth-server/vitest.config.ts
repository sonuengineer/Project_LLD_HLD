import { defineConfig } from "vitest/config";

// Every integration test starts its own server on an ephemeral port, so files could run in parallel;
// they run one after another anyway because scrypt (used for every login) is CPU and memory heavy and
// parallel files made timings noisy.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20000 } });
