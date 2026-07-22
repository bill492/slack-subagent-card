import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readInspectionContract } from "./inspection-contract.mjs";
import { output, run } from "./process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function digestTarball(tarball) {
  const bytes = await readFile(tarball);
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function tarJson(tarball, member) {
  return parseJson(output("tar", ["-xOf", tarball, member]), member);
}

function validateTarball(tarball) {
  const members = output("tar", ["-tf", tarball]).split("\n").filter(Boolean);
  for (const required of [
    "package/package.json",
    "package/openclaw.plugin.json",
    "package/index.ts",
    "package/dist/index.js",
  ]) {
    assert(members.includes(required), `packed artifact is missing ${required}`);
  }
  for (const forbidden of members.filter((entry) => /(^|\/)(?:reports|\.release|node_modules)(?:\/|$)/.test(entry))) {
    throw new Error(`packed artifact contains forbidden path ${forbidden}`);
  }

  const packageJson = tarJson(tarball, "package/package.json");
  const manifest = tarJson(tarball, "package/openclaw.plugin.json");
  assert(packageJson.name, "packed package.json has no name");
  assert(packageJson.version === manifest.version, "packed package and manifest versions differ");
  assert(manifest.id, "packed manifest has no plugin id");
  assert(
    packageJson.openclaw?.runtimeExtensions?.includes("./dist/index.js"),
    "packed package does not advertise ./dist/index.js as a runtime extension",
  );
  return { packageJson, manifest, members };
}

function validateLockedOpenClaw(packageJson) {
  const declared = packageJson.devDependencies?.openclaw;
  const buildVersion = packageJson.openclaw?.build?.openclawVersion;
  const sdkVersion = packageJson.openclaw?.build?.pluginSdkVersion;
  assert(declared && !/[<>=~^*xX| ]/.test(declared), "devDependencies.openclaw must be an exact version");
  assert(declared === buildVersion, "devDependencies.openclaw and openclaw.build.openclawVersion differ");
  assert(declared === sdkVersion, "devDependencies.openclaw and openclaw.build.pluginSdkVersion differ");

  const installed = parseJson(
    output(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./node_modules/openclaw/package.json')))"], {
      cwd: repoRoot,
    }),
    "installed OpenClaw package.json",
  );
  assert(installed.version === declared, `installed OpenClaw ${installed.version} does not match lock target ${declared}`);
  return declared;
}

function validateRuntimeInspection(inspection, expected, expectedHooks) {
  assert(inspection.plugin?.id === expected.pluginId, `runtime loaded unexpected plugin id ${inspection.plugin?.id}`);
  assert(inspection.plugin?.version === expected.version, `runtime loaded unexpected version ${inspection.plugin?.version}`);
  assert(inspection.plugin?.status === "loaded", `runtime plugin status is ${inspection.plugin?.status}`);
  assert(inspection.install?.artifactKind === "npm-pack", "runtime install was not recorded as npm-pack");

  const hooks = (inspection.typedHooks ?? []).map((entry) => entry.name).sort();
  assert(JSON.stringify(hooks) === JSON.stringify(expectedHooks), `runtime hooks differ: ${hooks.join(", ")}`);
  const errors = (inspection.diagnostics ?? []).filter((entry) => entry.level === "error");
  assert(errors.length === 0, `runtime inspection reported errors: ${errors.map((entry) => entry.message).join("; ")}`);
}

export async function smokePackedInstall(options = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "slack-subagent-card-pack-smoke-"));
  try {
    let tarball = options.tarball ? path.resolve(options.tarball) : null;
    let packResult = null;
    if (!tarball) {
      const result = parseJson(
        output("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: repoRoot }),
        "npm pack",
      );
      assert(Array.isArray(result) && result.length === 1, "npm pack did not produce exactly one artifact");
      packResult = result[0];
      tarball = path.join(scratch, packResult.filename);
    }

    const { packageJson, manifest } = validateTarball(tarball);
    const inspectionContract = await readInspectionContract(repoRoot);
    assert(inspectionContract.pluginId === manifest.id, "inspector config plugin id differs from packed manifest");
    const openclawVersion = validateLockedOpenClaw(packageJson);
    const digest = await digestTarball(tarball);
    if (packResult) {
      assert(packResult.integrity === digest.integrity, "npm pack integrity does not match tarball bytes");
      assert(packResult.shasum === digest.shasum, "npm pack shasum does not match tarball bytes");
    }

    const stateDir = path.join(scratch, "openclaw-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const openclawBin = path.join(repoRoot, "node_modules", ".bin", "openclaw");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };

    run(openclawBin, ["plugins", "install", `npm-pack:${tarball}`, "--force"], {
      cwd: repoRoot,
      env,
      capture: true,
    });
    const inspection = parseJson(
      output(openclawBin, ["plugins", "inspect", manifest.id, "--runtime", "--json"], {
        cwd: repoRoot,
        env,
      }),
      "openclaw plugins inspect",
    );
    validateRuntimeInspection(
      inspection,
      { pluginId: manifest.id, version: packageJson.version },
      inspectionContract.hooks,
    );

    return {
      tarball,
      packageName: packageJson.name,
      pluginId: manifest.id,
      version: packageJson.version,
      openclawVersion,
      ...digest,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tarballIndex = process.argv.indexOf("--tarball");
  const tarball = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : undefined;
  if (tarballIndex >= 0 && !tarball) {
    throw new Error("--tarball requires a path");
  }
  const result = await smokePackedInstall({ tarball });
  process.stdout.write(
    `Packed install smoke passed for ${result.packageName}@${result.version} on OpenClaw ${result.openclawVersion}\n`,
  );
}
