import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/** The shutdown test runs the REAL built CLI as a separate process, so make sure dist/ is current. */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
