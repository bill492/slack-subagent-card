import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readInspectionContract } from "./inspection-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(repoRoot, "reports", "plugin-inspector-runtime-capture.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const { hooks: expectedHooks } = await readInspectionContract(repoRoot);
const expectedEntrypoints = ["dist/index.js", "index.ts"];

const results = report.results ?? [];
const entrypoints = results.map((entry) => entry.entrypoint.replace(/^.*\/(dist\/index\.js|index\.ts)$/, "$1")).sort();
if (JSON.stringify(entrypoints) !== JSON.stringify(expectedEntrypoints)) {
  throw new Error(`inspector runtime entrypoints differ: ${entrypoints.join(", ")}`);
}
for (const result of results) {
  if (result.status !== "captured") {
    throw new Error(`inspector did not capture ${result.entrypoint}: ${result.status}`);
  }
  const hooks = (result.captured ?? [])
    .filter((entry) => entry.kind === "hook")
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(hooks) !== JSON.stringify(expectedHooks)) {
    throw new Error(`inspector hooks differ for ${result.entrypoint}: ${hooks.join(", ")}`);
  }
}

process.stdout.write("Inspector captured source and built entrypoints with all expected hooks.\n");
