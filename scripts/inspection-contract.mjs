import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readInspectionContract(repoRoot) {
  const file = path.join(repoRoot, "plugin-inspector.config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  const hooks = config.plugin?.expect?.hooks;
  if (!Array.isArray(hooks) || hooks.length === 0 || hooks.some((hook) => typeof hook !== "string" || hook === "")) {
    throw new Error("plugin inspector config must declare nonempty expected hooks");
  }
  if (new Set(hooks).size !== hooks.length) {
    throw new Error("plugin inspector expected hooks must be unique");
  }
  return {
    pluginId: config.plugin?.id,
    hooks: [...hooks].sort(),
  };
}
