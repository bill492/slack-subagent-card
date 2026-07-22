import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOnlyVersionFilesChanged,
  decidePublishedArtifact,
  decideRemotePushState,
  deriveReleaseIdentity,
  parseGithubReleaseResult,
  parseNpmMetadataResult,
  parseNpmVersionsResult,
  parseRemoteRefResult,
  validateArtifactIdentity,
  validateRemoteUrls,
  validateResumeIdentity,
  validateReleaseTarget,
  validateStableReleaseVersion,
} from "./release-helpers.mjs";
import { smokePackedInstall } from "./packed-install-smoke.mjs";
import { output, run } from "./process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRegistry = "https://registry.npmjs.org/";
const releaseVersionFiles = ["openclaw.plugin.json", "package-lock.json", "package.json"];
process.env.NPM_CONFIG_CACHE ||= path.join(repoRoot, ".release", "npm-cache");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(repoRoot, file), "utf8"));
}

async function readIdentity() {
  return deriveReleaseIdentity(
    await readJson("package.json"),
    await readJson("openclaw.plugin.json"),
    await readJson("package-lock.json"),
  );
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function statePaths(version) {
  validateStableReleaseVersion(version);
  const directory = path.join(repoRoot, ".release", `v${version}`);
  return { directory, file: path.join(directory, "release-state.json") };
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeState(state) {
  const paths = statePaths(state.version);
  await mkdir(paths.directory, { recursive: true });
  const temporary = `${paths.file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, paths.file);
}

async function readState(version) {
  const { file } = statePaths(version);
  if (!(await pathExists(file))) {
    throw new Error(`no release state exists for v${version}`);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

function commandResult(command, args) {
  return run(command, args, { cwd: repoRoot, capture: true, allowFailure: true });
}

function ensureCommand(command, args = ["--version"]) {
  const result = commandResult(command, args);
  if (result.status !== 0) {
    throw new Error(`required command is unavailable: ${command}`);
  }
}

function registryArgs(args) {
  return [...args, "--registry", canonicalRegistry];
}

function npmVersions(packageName) {
  const result = commandResult("npm", registryArgs(["view", packageName, "versions", "--json"]));
  return parseNpmVersionsResult(result);
}

function npmPublishedMetadata(packageName, version) {
  const result = commandResult("npm", registryArgs([
    "view",
    `${packageName}@${version}`,
    "version",
    "dist.integrity",
    "dist.shasum",
    "--json",
  ]));
  return parseNpmMetadataResult(result);
}

function assertNpmTargetAbsent(packageName, version) {
  if (npmPublishedMetadata(packageName, version)) {
    throw new Error(`${packageName}@${version} already exists on npm`);
  }
}

function assertLocalTagAbsent(tag) {
  const result = commandResult("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (result.status === 0) {
    throw new Error(`local tag ${tag} already exists`);
  }
  if (result.status !== 1) {
    throw new Error(`could not determine whether local tag ${tag} exists`);
  }
}

function remoteRef(ref) {
  const result = commandResult("git", ["ls-remote", "--exit-code", "origin", ref]);
  return parseRemoteRefResult(result, ref);
}

function assertRemoteTagAbsent(tag) {
  if (remoteRef(`refs/tags/${tag}`)) {
    throw new Error(`remote tag ${tag} already exists`);
  }
}

function githubRelease(repository, tag) {
  const result = commandResult("gh", ["api", `repos/${repository}/releases/tags/${tag}`]);
  return parseGithubReleaseResult(result, tag);
}

function assertGithubReleaseAbsent(repository, tag) {
  if (githubRelease(repository, tag)) {
    throw new Error(`GitHub release ${tag} already exists`);
  }
}

function repositoryContext(repository) {
  const raw = output("gh", ["repo", "view", repository, "--json", "defaultBranchRef,nameWithOwner,viewerPermission"], {
    cwd: repoRoot,
  });
  const context = parseJson(raw, "GitHub repository context");
  assert(context && typeof context === "object" && !Array.isArray(context), "GitHub repository context is empty");
  assert(typeof context.nameWithOwner === "string" && context.nameWithOwner !== "", "GitHub repository identity is missing");
  assert(typeof context.viewerPermission === "string", "GitHub repository permission is missing");
  assert(context.nameWithOwner.toLowerCase() === repository.toLowerCase(), "GitHub repository identity mismatch");
  assert(["ADMIN", "MAINTAIN", "WRITE"].includes(context.viewerPermission), "GitHub account lacks repository write permission");
  assert(context.defaultBranchRef?.name, "GitHub repository has no default branch");
  return { defaultBranch: context.defaultBranchRef.name };
}

function assertOriginUrls(repository) {
  const fetchUrls = output("git", ["remote", "get-url", "--all", "origin"], { cwd: repoRoot })
    .split("\n")
    .filter(Boolean);
  const pushUrls = output("git", ["remote", "get-url", "--push", "--all", "origin"], { cwd: repoRoot })
    .split("\n")
    .filter(Boolean);
  validateRemoteUrls(fetchUrls, pushUrls, repository);
}

function assertRemoteHead(defaultBranch, expected) {
  const actual = remoteRef(`refs/heads/${defaultBranch}`);
  assert(actual, `remote default branch ${defaultBranch} is missing`);
  assert(actual === expected, `origin/${defaultBranch} moved: expected ${expected}, got ${actual}`);
}

function assertCleanWorktree() {
  const status = output("git", ["status", "--porcelain"], { cwd: repoRoot });
  assert(status === "", "release requires a clean worktree");
}

async function fullReadOnlyPreflight(target) {
  validateStableReleaseVersion(target);
  ensureCommand("git");
  ensureCommand("npm");
  ensureCommand("gh");
  assertCleanWorktree();

  const identity = await readIdentity();
  const tag = `v${target}`;
  const registry = output("npm", ["config", "get", "registry"], { cwd: repoRoot });
  assert(registry === canonicalRegistry, `npm registry must be ${canonicalRegistry}, got ${registry}`);

  run("gh", ["auth", "status", "-h", "github.com"], { cwd: repoRoot, capture: true });
  run("npm", registryArgs(["whoami"]), { cwd: repoRoot, capture: true });
  const { defaultBranch } = repositoryContext(identity.repository);
  assertOriginUrls(identity.repository);
  const currentBranch = output("git", ["branch", "--show-current"], { cwd: repoRoot });
  assert(currentBranch === defaultBranch, `release must run from default branch ${defaultBranch}, got ${currentBranch}`);

  run("git", ["fetch", "--prune", "origin", defaultBranch, "--tags"], { cwd: repoRoot });
  const baseCommit = output("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  assertRemoteHead(defaultBranch, baseCommit);
  validateReleaseTarget(target, identity.version, npmVersions(identity.packageName));
  assertNpmTargetAbsent(identity.packageName, target);
  assertLocalTagAbsent(tag);
  assertRemoteTagAbsent(tag);
  assertGithubReleaseAbsent(identity.repository, tag);

  run("npm", ["ci"], { cwd: repoRoot });
  run("npm", ["run", "preflight"], { cwd: repoRoot });
  assertCleanWorktree();
  return { ...identity, target, tag, defaultBranch, baseCommit };
}

async function updateManifestVersion(version) {
  const file = path.join(repoRoot, "openclaw.plugin.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.version = version;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function captureReleaseFileHashes() {
  return Object.fromEntries(
    await Promise.all(
      releaseVersionFiles.map(async (file) => [file, sha256(await readFile(path.join(repoRoot, file)))]),
    ),
  );
}

function assertExactReleaseFileSet(files, label) {
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(releaseVersionFiles)) {
    throw new Error(`${label} must contain exactly ${releaseVersionFiles.join(", ")}; got ${actual.join(", ")}`);
  }
}

async function verifyReleaseCommit(state, expectedHashes) {
  const parents = output("git", ["rev-list", "--parents", "-n", "1", state.releaseCommit], { cwd: repoRoot }).split(/\s+/);
  assert(parents.length === 2 && parents[1] === state.baseCommit, "release commit is not a direct child of the preflight base");
  const changedFiles = output("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", state.releaseCommit], {
    cwd: repoRoot,
  }).split("\n").filter(Boolean);
  assertExactReleaseFileSet(changedFiles, "release commit");
  assertExactReleaseFileSet(Object.keys(expectedHashes), "saved committed-file hashes");
  for (const file of releaseVersionFiles) {
    const committed = run("git", ["show", `${state.releaseCommit}:${file}`], {
      cwd: repoRoot,
      capture: true,
    }).stdout;
    const working = await readFile(path.join(repoRoot, file));
    assert(sha256(committed) === expectedHashes[file], `committed ${file} differs from pre-commit bytes`);
    assert(sha256(working) === expectedHashes[file], `working ${file} differs from committed release bytes`);
  }
  const identity = await readIdentity();
  assert(identity.version === state.version, "committed package identity does not match the release target");
  assert(identity.packageName === state.packageName && identity.pluginId === state.pluginId, "committed package/plugin identity changed");
  assert(identity.repository === state.repository && identity.openclawVersion === state.openclawVersion, "committed repository/OpenClaw identity changed");
  assertCleanWorktree();
}

async function verifyPublished(state, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const metadata = npmPublishedMetadata(state.packageName, state.version);
    if (metadata) {
      decidePublishedArtifact(metadata, state);
      return metadata;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error(`${state.packageName}@${state.version} did not become visible on npm`);
}

function atomicPush(state, dryRun = false) {
  const args = [
    "push",
    ...(dryRun ? ["--dry-run"] : []),
    "--atomic",
    "origin",
    `${state.releaseCommit}:refs/heads/${state.defaultBranch}`,
    `refs/tags/${state.tag}:refs/tags/${state.tag}`,
  ];
  run("git", args, { cwd: repoRoot });
}

function immediatePrepublishChecks(state) {
  assertRemoteHead(state.defaultBranch, state.baseCommit);
  assertRemoteTagAbsent(state.tag);
  assertGithubReleaseAbsent(state.repository, state.tag);
  assertOriginUrls(state.repository);
  atomicPush(state, true);
  validateReleaseTarget(state.version, state.previousVersion, npmVersions(state.packageName));
  assertNpmTargetAbsent(state.packageName, state.version);
}

async function createCandidate(context) {
  let state = {
    schemaVersion: 1,
    version: context.target,
    previousVersion: context.version,
    tag: context.tag,
    packageName: context.packageName,
    pluginId: context.pluginId,
    repository: context.repository,
    openclawVersion: context.openclawVersion,
    defaultBranch: context.defaultBranch,
    baseCommit: context.baseCommit,
  };
  const paths = statePaths(state.version);
  assert(!(await pathExists(paths.file)), `release state already exists; use --resume ${state.version}`);
  await writeState(state);

  run("npm", ["version", state.version, "--no-git-tag-version", "--ignore-scripts"], { cwd: repoRoot });
  await updateManifestVersion(state.version);
  assertOnlyVersionFilesChanged(output("git", ["status", "--porcelain"], { cwd: repoRoot }));
  await writeState(state);

  run("npm", ["ci"], { cwd: repoRoot });
  run("npm", ["run", "preflight"], { cwd: repoRoot });
  assertOnlyVersionFilesChanged(output("git", ["status", "--porcelain"], { cwd: repoRoot }));
  const committedFiles = await captureReleaseFileHashes();

  run("git", ["add", "package.json", "package-lock.json", "openclaw.plugin.json"], { cwd: repoRoot });
  run("git", ["commit", "-m", `Release ${state.pluginId} ${state.tag}`], { cwd: repoRoot });
  state = {
    ...state,
    releaseCommit: output("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    committedFiles,
  };
  await verifyReleaseCommit(state, committedFiles);
  await writeState(state);
  run("git", ["tag", "-a", state.tag, "-m", `Release ${state.pluginId} ${state.tag}`], { cwd: repoRoot });

  const pack = parseJson(
    output("npm", ["pack", "--json", "--pack-destination", paths.directory], { cwd: repoRoot }),
    "npm pack",
  );
  assert(Array.isArray(pack) && pack.length === 1, "npm pack did not produce exactly one tarball");
  const tarball = path.join(paths.directory, pack[0].filename);
  const smoke = await smokePackedInstall({ tarball });
  const tarballBytes = await readFile(tarball);
  validateArtifactIdentity(smoke, {
    packageName: state.packageName,
    version: state.version,
    pluginId: state.pluginId,
    openclawVersion: state.openclawVersion,
    integrity: pack[0].integrity,
    shasum: pack[0].shasum,
    sha256: sha256(tarballBytes),
  });
  assertCleanWorktree();
  state = {
    ...state,
    tarball,
    integrity: smoke.integrity,
    shasum: smoke.shasum,
    sha256: smoke.sha256,
  };
  await writeState(state);
  return state;
}

async function publishIfNeeded(state) {
  const existing = npmPublishedMetadata(state.packageName, state.version);
  if (existing) {
    decidePublishedArtifact(existing, state);
    return state;
  }
  immediatePrepublishChecks(state);
  const publish = commandResult("npm", registryArgs(["publish", state.tarball, "--access", "public", "--tag", "latest"]));
  if (publish.status !== 0) {
    const uncertain = npmPublishedMetadata(state.packageName, state.version);
    if (!uncertain) {
      throw new Error(`npm publish failed before the target became visible: ${publish.stderr || publish.stdout}`);
    }
  }
  await verifyPublished(state);
  await writeState(state);
  return state;
}

function pushIfNeeded(state) {
  const remoteHead = remoteRef(`refs/heads/${state.defaultBranch}`);
  const remoteTag = remoteRef(`refs/tags/${state.tag}`);
  const remotePeeledTag = remoteRef(`refs/tags/${state.tag}^{}`);
  const decision = decideRemotePushState({
    remoteHead,
    remoteTag,
    remotePeeledTag,
    baseCommit: state.baseCommit,
    releaseCommit: state.releaseCommit,
  });
  if (decision === "already-pushed") {
    return state;
  }
  assertOriginUrls(state.repository);
  atomicPush(state);
  assertRemoteHead(state.defaultBranch, state.releaseCommit);
  assert(remoteRef(`refs/tags/${state.tag}^{}`) === state.releaseCommit, "remote annotated tag does not resolve to the release commit");
  return state;
}

function createGithubReleaseIfNeeded(state) {
  if (!githubRelease(state.repository, state.tag)) {
    run(
      "gh",
      [
        "release",
        "create",
        state.tag,
        `${state.tarball}#npm package`,
        "--repo",
        state.repository,
        "--verify-tag",
        "--title",
        state.tag,
        "--generate-notes",
      ],
      { cwd: repoRoot },
    );
  }
  let metadata = githubRelease(state.repository, state.tag);
  assert(metadata, "GitHub release disappeared after creation");
  const assetName = path.basename(state.tarball);
  if (!(metadata.assets ?? []).some((asset) => asset.name === assetName)) {
    run("gh", ["release", "upload", state.tag, state.tarball, "--repo", state.repository], { cwd: repoRoot });
    metadata = githubRelease(state.repository, state.tag);
    assert(metadata, "GitHub release disappeared after asset upload");
  }
  const asset = (metadata.assets ?? []).find((entry) => entry.name === assetName);
  assert(asset, `GitHub release is missing ${assetName}`);
  assert(asset.digest === `sha256:${state.sha256}`, `GitHub release asset digest differs for ${assetName}`);
  const release = parseJson(
    output("gh", ["release", "view", state.tag, "--repo", state.repository, "--json", "tagName,url,isDraft"], {
      cwd: repoRoot,
    }),
    "GitHub release verification",
  );
  assert(release && typeof release === "object" && !Array.isArray(release), "GitHub release verification returned empty metadata");
  assert(release.tagName === state.tag && release.isDraft === false, "GitHub release verification failed");
  return { ...state, githubReleaseUrl: release.url };
}

async function resumeRelease(version, initialState = null) {
  const resumedFromDisk = initialState === null;
  let state = initialState ?? (await readState(version));
  assert(state.version === version, "release state version mismatch");
  ensureCommand("git");
  ensureCommand("npm");
  ensureCommand("gh");
  assertCleanWorktree();
  const registry = output("npm", ["config", "get", "registry"], { cwd: repoRoot });
  assert(registry === canonicalRegistry, `npm registry must be ${canonicalRegistry}, got ${registry}`);
  run("gh", ["auth", "status", "-h", "github.com"], { cwd: repoRoot, capture: true });
  run("npm", registryArgs(["whoami"]), { cwd: repoRoot, capture: true });

  const identity = await readIdentity();
  const { defaultBranch } = repositoryContext(identity.repository);
  validateResumeIdentity(state, identity, defaultBranch);
  assertOriginUrls(identity.repository);
  assert(output("git", ["branch", "--show-current"], { cwd: repoRoot }) === defaultBranch, `resume must run from ${defaultBranch}`);
  assert(output("git", ["rev-parse", "HEAD"], { cwd: repoRoot }) === state.releaseCommit, "current HEAD is not the saved release commit");
  await verifyReleaseCommit(state, state.committedFiles);
  assert(output("git", ["cat-file", "-t", `refs/tags/${state.tag}`], { cwd: repoRoot }) === "tag", "saved release tag is missing or is not annotated");
  assert(output("git", ["rev-parse", `${state.tag}^{}`], { cwd: repoRoot }) === state.releaseCommit, "saved release tag does not resolve to the saved release commit");
  const releaseDirectory = statePaths(version).directory;
  const resolvedTarball = path.resolve(state.tarball);
  assert(resolvedTarball.startsWith(`${releaseDirectory}${path.sep}`), "saved tarball path is outside its release-state directory");
  assert(await pathExists(state.tarball), `release tarball is missing: ${state.tarball}`);

  if (resumedFromDisk) {
    const smoke = await smokePackedInstall({ tarball: state.tarball });
    validateArtifactIdentity(smoke, state);
  }
  state = await publishIfNeeded(state);
  await writeState(state);
  state = pushIfNeeded(state);
  await writeState(state);
  state = createGithubReleaseIfNeeded(state);
  await writeState(state);
  process.stdout.write(`Released ${state.packageName}@${state.version}\n${state.githubReleaseUrl}\n`);
}

async function checkOnly(target) {
  const identity = await readIdentity();
  if (target) {
    validateReleaseTarget(target, identity.version, []);
  }
  process.stdout.write(`${JSON.stringify({ ...identity, target: target ?? null }, null, 2)}\n`);
}

function usage() {
  return "Usage: node scripts/release.mjs X.Y.Z | --resume X.Y.Z | --metadata-check [X.Y.Z]";
}

const args = process.argv.slice(2);
let recoveryVersion = null;
try {
  if (args[0] === "--metadata-check" && args.length <= 2) {
    await checkOnly(args[1]);
  } else if (args[0] === "--resume" && args.length === 2) {
    validateStableReleaseVersion(args[1]);
    recoveryVersion = args[1];
    await resumeRelease(args[1]);
  } else if (args.length === 1 && !args[0].startsWith("-")) {
    validateStableReleaseVersion(args[0]);
    recoveryVersion = args[0];
    const context = await fullReadOnlyPreflight(args[0]);
    const state = await createCandidate(context);
    await resumeRelease(args[0], state);
  } else {
    throw new Error(usage());
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (recoveryVersion && (await pathExists(statePaths(recoveryVersion).file))) {
    const retained = await readState(recoveryVersion);
    if (
      retained.previousVersion &&
      retained.openclawVersion &&
      retained.releaseCommit &&
      retained.committedFiles &&
      retained.tarball &&
      retained.integrity &&
      retained.shasum &&
      retained.sha256
    ) {
      process.stderr.write(`Complete candidate state retained. Inspect it before running: npm run release -- --resume ${recoveryVersion}\n`);
    } else {
      process.stderr.write("Incomplete local candidate state retained. Inspect and repair or abandon it manually; resume will fail closed.\n");
    }
  }
  process.exitCode = 1;
}
