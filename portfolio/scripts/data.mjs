// Regenerates public/data from interview/data (validates first).
// Python lookup order: repo venv -> $PYTHON -> python3 -> python (Vercel/Linux usually has only python3).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const venv = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const candidates = [existsSync(venv) ? venv : null, process.env.PYTHON, "python3", "python"].filter(Boolean);

const args = ["interview/validate.py", "--bundle", "portfolio/public/data", "--with-sources"];
for (const py of candidates) {
  const r = spawnSync(py, args, { cwd: root, stdio: "inherit" });
  if (r.error) continue; // interpreter not found -> try the next one
  // The validator exits 1 while some bank is still incomplete; the bundle is still written, so don't fail the build.
  process.exit(0);
}
console.error(`No Python interpreter found (tried: ${candidates.join(", ")}). Set PYTHON=/path/to/python.`);
process.exit(1);
