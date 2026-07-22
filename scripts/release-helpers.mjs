import semver from "semver";

export function githubRepositorySlug(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("package.json repository.url is required");
  }
  const normalized = raw.trim().replace(/^git\+/, "");
  const match = normalized.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) {
    throw new Error(`package repository must be a GitHub URL, got ${raw}`);
  }
  return `${match[1]}/${match[2]}`;
}

export function validateReleaseTarget(target, current, publishedVersions) {
  validateStableReleaseVersion(target);
  validateCanonicalSemver(current, "current package version");
  const published = publishedVersions.map((value) => {
    return validateCanonicalSemver(value, "published npm version");
  });
  if (!semver.gt(target, current)) {
    throw new Error(`target ${target} must be greater than current ${current}`);
  }
  const blocking = published.find((version) => !semver.gt(target, version));
  if (blocking) {
    throw new Error(`target ${target} must be greater than every published version; blocked by ${blocking}`);
  }
  return target;
}

export function validateStableReleaseVersion(version) {
  if (semver.valid(version) !== version || semver.prerelease(version)) {
    throw new Error(`release version must be a stable semantic version, got ${version}`);
  }
  return version;
}

function validateCanonicalSemver(version, label) {
  if (typeof version !== "string" || semver.valid(version) !== version) {
    throw new Error(`${label} is not canonical semver: ${version}`);
  }
  return version;
}

export function deriveReleaseIdentity(packageJson, manifest, packageLock) {
  const packageName = packageJson.name;
  const version = packageJson.version;
  const pluginId = manifest.id;
  if (!packageName || !version || !pluginId) {
    throw new Error("package name, package version, and plugin manifest id are required");
  }
  validateCanonicalSemver(version, "package version");
  if (manifest.version !== version) {
    throw new Error(`version mismatch: package.json=${version}, openclaw.plugin.json=${manifest.version}`);
  }
  if (packageLock?.packages?.[""]?.version !== version || packageLock?.version !== version) {
    throw new Error("package-lock.json root version must match package.json");
  }
  if (packageLock?.name !== packageName || packageLock?.packages?.[""]?.name !== packageName) {
    throw new Error("package-lock.json root name must match package.json");
  }
  if (packageJson.openclaw?.install?.npmSpec !== packageName) {
    throw new Error("openclaw.install.npmSpec must match package.json name");
  }
  if (packageJson.openclaw?.install?.defaultChoice !== "npm") {
    throw new Error("openclaw.install.defaultChoice must be npm");
  }
  if (packageJson.openclaw?.release?.publishToNpm !== true) {
    throw new Error("openclaw.release.publishToNpm must be true");
  }
  if (packageJson.openclaw?.release?.publishToClawHub !== false) {
    throw new Error("openclaw.release.publishToClawHub must be false");
  }
  const openclawVersion = packageJson.devDependencies?.openclaw;
  validateCanonicalSemver(openclawVersion, "devDependencies.openclaw");
  if (
    packageJson.openclaw?.build?.openclawVersion !== openclawVersion ||
    packageJson.openclaw?.build?.pluginSdkVersion !== openclawVersion
  ) {
    throw new Error("OpenClaw dev, build, and plugin SDK versions must match exactly");
  }
  return {
    packageName,
    version,
    pluginId,
    repository: githubRepositorySlug(packageJson.repository),
    openclawVersion,
  };
}

export function validateResumeIdentity(state, identity, defaultBranch) {
  if (state.schemaVersion !== 1) {
    throw new Error(`unsupported release state schema: ${state.schemaVersion}`);
  }
  for (const [key, expected] of [
    ["version", identity.version],
    ["packageName", identity.packageName],
    ["pluginId", identity.pluginId],
    ["repository", identity.repository],
    ["openclawVersion", identity.openclawVersion],
    ["defaultBranch", defaultBranch],
  ]) {
    if (state[key] !== expected) {
      throw new Error(`release state ${key}=${state[key]} does not match current metadata ${expected}`);
    }
  }
  if (state.tag !== `v${state.version}`) {
    throw new Error(`release state tag ${state.tag} does not match version ${state.version}`);
  }
  validateReleaseTarget(state.version, state.previousVersion, []);
  for (const key of ["baseCommit", "releaseCommit", "tarball", "integrity", "shasum", "sha256"]) {
    if (typeof state[key] !== "string" || state[key] === "") {
      throw new Error(`release state is missing ${key}`);
    }
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(state.baseCommit) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(state.releaseCommit)) {
    throw new Error("release state contains an invalid Git commit id");
  }
  if (!state.integrity.startsWith("sha512-") || !/^[0-9a-f]{40}$/i.test(state.shasum) || !/^[0-9a-f]{64}$/i.test(state.sha256)) {
    throw new Error("release state contains an invalid artifact digest");
  }
  const committedKeys = Object.keys(state.committedFiles ?? {}).sort();
  if (JSON.stringify(committedKeys) !== JSON.stringify(["openclaw.plugin.json", "package-lock.json", "package.json"])) {
    throw new Error("release state committedFiles must contain exactly the three version files");
  }
  if (Object.values(state.committedFiles).some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest))) {
    throw new Error("release state committedFiles contains an invalid digest");
  }
  return state;
}

export function isExplicitNpm404(result) {
  if (result.status === 0 || result.signal) {
    return false;
  }
  return /"code"\s*:\s*"E404"/.test(`${result.stdout}\n${result.stderr}`);
}

export function isExplicitHttp404(result) {
  if (result.status === 0 || result.signal) {
    return false;
  }
  return /(?:HTTP\/\S+\s+404|HTTP 404)(?:\s|\)|$)/i.test(`${result.stdout}\n${result.stderr}`);
}

export function parseNpmMetadataResult(result) {
  if (result.signal) {
    throw new Error(`npm lookup was killed by ${result.signal}`);
  }
  if (result.status !== 0) {
    if (isExplicitNpm404(result)) {
      return null;
    }
    throw new Error(`npm lookup failed closed: ${result.stderr || result.stdout}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm lookup returned malformed JSON: ${error.message}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("npm lookup returned empty or non-object metadata");
  }
  validateCanonicalSemver(metadata.version, "npm metadata version");
  if (typeof metadata["dist.integrity"] !== "string" || !metadata["dist.integrity"].startsWith("sha512-")) {
    throw new Error("npm metadata is missing dist.integrity");
  }
  if (typeof metadata["dist.shasum"] !== "string" || !/^[0-9a-f]{40}$/i.test(metadata["dist.shasum"])) {
    throw new Error("npm metadata is missing a valid dist.shasum");
  }
  return metadata;
}

export function parseNpmVersionsResult(result) {
  if (result.signal) {
    throw new Error(`npm versions lookup was killed by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm versions lookup failed closed: ${result.stderr || result.stdout}`);
  }
  let versions;
  try {
    versions = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm versions lookup returned malformed JSON: ${error.message}`);
  }
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("npm versions lookup returned empty or non-array metadata");
  }
  return versions.map((version) => validateCanonicalSemver(version, "published npm version"));
}

export function parseRemoteRefResult(result, expectedRef) {
  if (result.signal) {
    throw new Error(`remote ref lookup was killed by ${result.signal}`);
  }
  if (result.status === 2) {
    if (`${result.stdout}${result.stderr}`.trim() !== "") {
      throw new Error(`remote ref absence for ${expectedRef} returned unexpected output`);
    }
    return null;
  }
  if (result.status !== 0) {
    throw new Error(`remote ref lookup failed for ${expectedRef}: ${result.stderr || result.stdout}`);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`remote ref lookup for ${expectedRef} returned ${lines.length} records`);
  }
  const [hash, ref, ...extra] = lines[0].trim().split(/\s+/);
  if (extra.length || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash ?? "") || ref !== expectedRef) {
    throw new Error(`remote ref lookup for ${expectedRef} returned malformed output`);
  }
  return hash;
}

export function parseGithubReleaseResult(result, expectedTag) {
  if (result.signal) {
    throw new Error(`GitHub release lookup was killed by ${result.signal}`);
  }
  if (result.status !== 0) {
    if (isExplicitHttp404(result)) {
      return null;
    }
    throw new Error(`GitHub release lookup failed closed: ${result.stderr || result.stdout}`);
  }
  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub release lookup returned malformed JSON: ${error.message}`);
  }
  if (
    !release ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    !release.id ||
    release.tag_name !== expectedTag ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("GitHub release lookup returned empty or mismatched metadata");
  }
  return release;
}

export function validateRemoteUrls(fetchUrls, pushUrls, repository) {
  for (const [kind, urls] of [["fetch", fetchUrls], ["push", pushUrls]]) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error(`origin has no ${kind} URLs`);
    }
    for (const url of urls) {
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error(`origin has an empty ${kind} URL`);
      }
      if (githubRepositorySlug(url).toLowerCase() !== repository.toLowerCase()) {
        throw new Error(`origin ${kind} URL ${url} does not match ${repository}`);
      }
    }
  }
}

export function decideRemotePushState({ remoteHead, remoteTag, remotePeeledTag, baseCommit, releaseCommit }) {
  if (remoteHead === releaseCommit && remoteTag && remotePeeledTag === releaseCommit) {
    return "already-pushed";
  }
  if (remoteHead === baseCommit && remoteTag === null && remotePeeledTag === null) {
    return "needs-atomic-push";
  }
  throw new Error("remote branch/tag state is neither clean pre-push nor fully released");
}

export function decidePublishedArtifact(metadata, expected) {
  if (metadata === null) {
    return "absent";
  }
  if (
    metadata.version === expected.version &&
    metadata["dist.integrity"] === expected.integrity &&
    metadata["dist.shasum"] === expected.shasum
  ) {
    return "matching";
  }
  throw new Error("published npm artifact does not match the saved release artifact");
}

export function validateArtifactIdentity(actual, expected) {
  for (const key of ["packageName", "version", "pluginId", "openclawVersion", "integrity", "shasum", "sha256"]) {
    if (typeof expected[key] !== "string" || expected[key] === "" || actual[key] !== expected[key]) {
      throw new Error(`artifact ${key}=${actual[key]} does not match expected ${expected[key]}`);
    }
  }
  return actual;
}

export function parsePorcelainPaths(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1));
}

export function assertOnlyVersionFilesChanged(output) {
  const expected = new Set(["openclaw.plugin.json", "package-lock.json", "package.json"]);
  const actual = parsePorcelainPaths(output);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) {
    throw new Error(`version mutation changed unexpected files: ${actual.join(", ") || "none"}`);
  }
}
