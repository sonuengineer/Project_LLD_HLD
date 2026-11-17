// Regenerates public/data from interview/data (validates first). Uses the repo venv if present, else `python`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const venv = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const py = existsSync(venv) ? venv : process.env.PYTHON || "python";
const r = spawnSync(py, ["interview/validate.py", "--bundle", "portfolio/public/data", "--with-sources"],
  { cwd: root, stdio: "inherit" });
// The validator exits 1 while some bank is still incomplete; the bundle is still written, so don't fail the build.
process.exit(r.error ? 1 : 0);
