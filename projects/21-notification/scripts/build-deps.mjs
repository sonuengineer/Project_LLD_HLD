// The libraries this project uses live next to it (file: dependencies) and are consumed from their dist/ output,
// which is not committed. On a fresh clone: npm run build:deps (installs and builds each one), then npm ci.
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const lib of ["18-resilience", "19-rate-limit", "20-cache"]) {
  const cwd = join(here, "..", "..", lib);
  console.log(`--- ${lib}`);
  execSync("npm ci --no-audit --no-fund", { cwd, stdio: "inherit" });
  execSync("npm run build", { cwd, stdio: "inherit" });
}
