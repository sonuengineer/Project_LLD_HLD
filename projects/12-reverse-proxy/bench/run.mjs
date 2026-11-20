// Usage:  node run.mjs all            node run.mjs e1 e3          BENCH_QUICK=1 node run.mjs all   (short dry run)
// Writes bench/results/<timestamp>-<label>/ with env.json, one eN.json per experiment, and SUMMARY.md.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cpuShare, cpuTimes, envInfo, makeResultsDir, save } from "./lib.mjs";
import { scenarios } from "./scenarios.mjs";

const args = process.argv.slice(2);
const label = (args.find((a) => a.startsWith("--label=")) ?? "--label=run").slice(8);
const names = args.filter((a) => !a.startsWith("--"));
const chosen = names.length === 0 || names.includes("all") ? Object.keys(scenarios) : names;
for (const n of chosen) if (!scenarios[n]) throw new Error(`unknown experiment "${n}" (have: ${Object.keys(scenarios).join(", ")})`);

const dir = makeResultsDir(label);
const cpuStart = cpuTimes();
const wallStart = Date.now();
const env = envInfo();
save(dir, "env.json", env);
console.log(`results -> ${dir}\n${JSON.stringify(env)}\n`);

const table = (columns, rows) =>
  [`| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map((c) => String(c ?? "-").replace(/\|/g, "/")).join(" | ")} |`)].join("\n");

const md = [
  "# Measured results",
  "",
  `Date: ${env.date}  |  Node ${env.node}  |  ${env.platform}  |  ${env.cpus} CPUs (${env.cpuModel})  |  commit ${env.commit}${env.dirty ? " (uncommitted changes)" : ""}${env.quick ? "  |  QUICK DRY RUN, not real numbers" : ""}`,
  "",
  "Everything ran on ONE machine (load generator, proxy and upstreams share the CPUs). Read the comparisons, not the absolute numbers.",
  "",
];

for (const name of chosen) {
  console.log(`--- ${name} ...`);
  const started = Date.now();
  let result;
  try {
    result = await scenarios[name]();
  } catch (err) {
    result = { failed: String(err?.stack ?? err) };
  }
  save(dir, `${name}.json`, { ...result, seconds: Math.round((Date.now() - started) / 1000) });
  if (result.skipped) {
    console.log(`    skipped: ${result.skipped}`);
    md.push(`## ${name.toUpperCase()}`, "", `Skipped: ${result.skipped}`, "");
  } else if (result.failed) {
    console.log(`    FAILED: ${result.failed}`);
    md.push(`## ${name.toUpperCase()}`, "", "FAILED:", "", "```", result.failed, "```", "");
  } else {
    console.log(`    ${result.title}\n${table(result.columns, result.rows).replace(/^/gm, "    ")}`);
    md.push(`## ${result.title}`, "", result.note, "", table(result.columns, result.rows), "", `Raw data: \`${name}.json\``, "");
  }
}
const share = cpuShare(cpuStart, cpuTimes());
const seconds = Math.round((Date.now() - wallStart) / 1000);
save(dir, "env.json", { ...env, wallSeconds: seconds, cpuShareDuringRun: share });
md.splice(
  4,
  0,
  share
    ? `Whole run took ${seconds}s. CPU time over the run (all cores): busy ${share.busy}%, idle ${share.idle}%, iowait ${share.iowait}%, STEAL ${share.steal}% (steal is time the hypervisor gave to other tenants; high steal means noisy numbers).`
    : `Whole run took ${seconds}s. CPU steal was not recorded (not Linux).`,
  "",
);
writeFileSync(path.join(dir, "SUMMARY.md"), md.join("\n") + "\n");
console.log(`\nSUMMARY.md written to ${dir}`);
