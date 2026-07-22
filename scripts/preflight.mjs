import { fileURLToPath } from "node:url";
import path from "node:path";
import { run } from "./process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [command, args] of [
  ["npm", ["run", "check"]],
  ["npm", ["test"]],
  ["npm", ["run", "release:test"]],
  ["npm", ["run", "plugin:ci"]],
  ["npm", ["run", "pack:smoke"]],
]) {
  run(command, args, { cwd: repoRoot });
}
