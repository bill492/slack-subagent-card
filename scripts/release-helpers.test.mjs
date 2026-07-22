import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertOnlyVersionFilesChanged,
  decidePublishedArtifact,
  decideRemotePushState,
  deriveReleaseIdentity,
  githubRepositorySlug,
  isExplicitHttp404,
  isExplicitNpm404,
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

test("derives GitHub repository slugs from supported metadata forms", () => {
  assert.equal(githubRepositorySlug("git+https://github.com/unblocklabs-ai/slack-subagent-card.git"), "unblocklabs-ai/slack-subagent-card");
  assert.equal(githubRepositorySlug({ url: "git@github.com:bill492/slack-subagent-card.git" }), "bill492/slack-subagent-card");
  assert.throws(() => githubRepositorySlug("https://gitlab.com/example/plugin.git"), /GitHub URL/);
});

test("requires a stable target newer than current and every published version", () => {
  assert.equal(validateReleaseTarget("1.3.0", "1.2.14", ["1.0.0", "1.2.14"]), "1.3.0");
  assert.throws(() => validateReleaseTarget("1.2.14", "1.2.13", ["1.2.14"]), /every published/);
  assert.throws(() => validateReleaseTarget("1.3.0-beta.1", "1.2.14", ["1.2.14"]), /stable semantic/);
  assert.throws(() => validateReleaseTarget("01.3.0", "1.2.14", ["1.2.14"]), /stable semantic/);
  assert.throws(() => validateReleaseTarget("1.3.0", "v1.2.14", ["1.2.14"]), /canonical semver/);
});

test("rejects unsafe release-state path versions", () => {
  assert.equal(validateStableReleaseVersion("1.2.15"), "1.2.15");
  assert.throws(() => validateStableReleaseVersion("../../outside"), /stable semantic/);
});

test("derives and cross-checks package identity", () => {
  const packageJson = {
    name: "@unblocklabs/slack-subagent-card",
    version: "1.2.14",
    repository: { url: "git+https://github.com/bill492/slack-subagent-card.git" },
    devDependencies: { openclaw: "2026.7.2-beta.3" },
    openclaw: {
      install: { npmSpec: "@unblocklabs/slack-subagent-card", defaultChoice: "npm" },
      release: { publishToNpm: true, publishToClawHub: false },
      build: { openclawVersion: "2026.7.2-beta.3", pluginSdkVersion: "2026.7.2-beta.3" },
    },
  };
  const lock = {
    name: packageJson.name,
    version: packageJson.version,
    packages: { "": { name: packageJson.name, version: packageJson.version } },
  };
  assert.deepEqual(deriveReleaseIdentity(packageJson, { id: "slack-subagent-card", version: "1.2.14" }, lock), {
    packageName: packageJson.name,
    version: "1.2.14",
    pluginId: "slack-subagent-card",
    repository: "bill492/slack-subagent-card",
    openclawVersion: "2026.7.2-beta.3",
  });
  assert.throws(
    () => deriveReleaseIdentity(packageJson, { id: "slack-subagent-card", version: "1.2.13" }, lock),
    /version mismatch/,
  );
});

test("absence classifiers fail closed", () => {
  assert.equal(isExplicitNpm404({ status: 1, signal: null, stdout: "", stderr: '{"error":{"code":"E404"}}' }), true);
  assert.equal(isExplicitNpm404({ status: 1, stdout: "", stderr: "network failure" }), false);
  assert.equal(isExplicitHttp404({ status: 1, stdout: "HTTP/2.0 404 Not Found", stderr: "" }), true);
  assert.equal(isExplicitHttp404({ status: 1, stdout: "", stderr: "authentication failed" }), false);
});

test("npm metadata decisions distinguish absence, match, mismatch, and malformed success", () => {
  const metadata = {
    version: "1.2.15",
    "dist.integrity": "sha512-value",
    "dist.shasum": "0123456789012345678901234567890123456789",
  };
  const present = parseNpmMetadataResult({ status: 0, signal: null, stdout: JSON.stringify(metadata), stderr: "" });
  assert.equal(decidePublishedArtifact(present, { version: "1.2.15", integrity: "sha512-value", shasum: metadata["dist.shasum"] }), "matching");
  assert.equal(
    decidePublishedArtifact(
      parseNpmMetadataResult({ status: 1, signal: null, stdout: '{"error":{"code":"E404"}}', stderr: "" }),
      {},
    ),
    "absent",
  );
  const expected = { version: "1.2.15", integrity: "sha512-value", shasum: metadata["dist.shasum"] };
  for (const key of Object.keys(expected)) {
    assert.throws(() => decidePublishedArtifact(present, { ...expected, [key]: "mismatch" }), /does not match/);
  }
  for (const stdout of ["", "null", "[]", "{}", "not-json"]) {
    assert.throws(() => parseNpmMetadataResult({ status: 0, signal: null, stdout, stderr: "" }), /npm (?:lookup|metadata)/);
  }
  assert.throws(() => parseNpmMetadataResult({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }), /killed/);
});

test("npm versions lookup requires a nonempty canonical semver array", () => {
  const result = (stdout) => ({ status: 0, signal: null, stdout, stderr: "" });
  assert.deepEqual(parseNpmVersionsResult(result('["1.0.0","1.2.14"]')), ["1.0.0", "1.2.14"]);
  for (const stdout of ["", "null", "[]", '"1.2.14"', "{}", '["v1.2.14"]', '["1.2.14",null]', "not-json"]) {
    assert.throws(() => parseNpmVersionsResult(result(stdout)), /npm versions lookup|canonical semver/);
  }
  assert.throws(
    () => parseNpmVersionsResult({ status: 1, signal: null, stdout: "", stderr: "network failure" }),
    /failed closed/,
  );
  assert.throws(
    () => parseNpmVersionsResult({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }),
    /killed/,
  );
});

test("remote ref and atomic push decisions fail closed for partial or malformed state", () => {
  const base = "a".repeat(40);
  const release = "b".repeat(40);
  assert.equal(parseRemoteRefResult({ status: 0, signal: null, stdout: `${base}\trefs/heads/main\n`, stderr: "" }, "refs/heads/main"), base);
  assert.equal(parseRemoteRefResult({ status: 2, signal: null, stdout: "", stderr: "" }, "refs/tags/v1.2.15"), null);
  assert.throws(() => parseRemoteRefResult({ status: 0, signal: null, stdout: "", stderr: "" }, "refs/heads/main"), /0 records/);
  assert.throws(() => parseRemoteRefResult({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }, "refs/heads/main"), /killed/);
  const cases = [
    [{ remoteHead: base, remoteTag: null, remotePeeledTag: null, baseCommit: base, releaseCommit: release }, "needs-atomic-push"],
    [{ remoteHead: release, remoteTag: "c".repeat(40), remotePeeledTag: release, baseCommit: base, releaseCommit: release }, "already-pushed"],
  ];
  for (const [input, expected] of cases) assert.equal(decideRemotePushState(input), expected);
  for (const input of [
    { remoteHead: release, remoteTag: null, remotePeeledTag: null, baseCommit: base, releaseCommit: release },
    { remoteHead: base, remoteTag: "c".repeat(40), remotePeeledTag: release, baseCommit: base, releaseCommit: release },
    { remoteHead: "d".repeat(40), remoteTag: null, remotePeeledTag: null, baseCommit: base, releaseCommit: release },
    { remoteHead: release, remoteTag: "c".repeat(40), remotePeeledTag: base, baseCommit: base, releaseCommit: release },
  ]) {
    assert.throws(() => decideRemotePushState(input), /neither/);
  }
});

test("GitHub release lookup and remote URL sets reject malformed or mismatched state", () => {
  assert.equal(parseGithubReleaseResult({ status: 1, signal: null, stdout: "", stderr: "gh: Not Found (HTTP 404)" }, "v1.2.15"), null);
  assert.equal(parseGithubReleaseResult({ status: 0, signal: null, stdout: '{"id":1,"tag_name":"v1.2.15","assets":[]}', stderr: "" }, "v1.2.15").id, 1);
  for (const stdout of ["", "null", "{}", '{"id":1,"tag_name":"wrong"}']) {
    assert.throws(() => parseGithubReleaseResult({ status: 0, signal: null, stdout, stderr: "" }, "v1.2.15"), /GitHub release lookup/);
  }
  assert.doesNotThrow(() => validateRemoteUrls(
    ["https://github.com/unblocklabs-ai/slack-subagent-card.git"],
    ["git@github.com:unblocklabs-ai/slack-subagent-card.git"],
    "unblocklabs-ai/slack-subagent-card",
  ));
  assert.throws(() => validateRemoteUrls([], ["git@github.com:unblocklabs-ai/slack-subagent-card.git"], "unblocklabs-ai/slack-subagent-card"), /no fetch/);
  assert.throws(() => validateRemoteUrls(["https://github.com/attacker/repo.git"], ["git@github.com:unblocklabs-ai/slack-subagent-card.git"], "unblocklabs-ai/slack-subagent-card"), /does not match/);
});

test("release mutation boundaries revalidate origin URLs immediately before each atomic push", () => {
  const source = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
  const prepublish = source.slice(
    source.indexOf("function immediatePrepublishChecks"),
    source.indexOf("async function createCandidate"),
  );
  assert.match(prepublish, /assertOriginUrls\(state\.repository\);\s*atomicPush\(state, true\);/);

  const push = source.slice(source.indexOf("function pushIfNeeded"), source.indexOf("function createGithubReleaseIfNeeded"));
  assert.match(push, /assertOriginUrls\(state\.repository\);\s*atomicPush\(state\);/);
});

test("artifact identity binds package, plugin, OpenClaw, and every digest", () => {
  const expected = {
    packageName: "@unblocklabs/slack-subagent-card",
    version: "1.2.15",
    pluginId: "slack-subagent-card",
    openclawVersion: "2026.7.2-beta.3",
    integrity: "sha512-value",
    shasum: "sha1-value",
    sha256: "sha256-value",
  };
  assert.equal(validateArtifactIdentity({ ...expected }, expected).version, "1.2.15");
  for (const key of Object.keys(expected)) {
    assert.throws(() => validateArtifactIdentity({ ...expected, [key]: "mismatch" }, expected), new RegExp(`artifact ${key}`));
  }
});

test("version mutation permits only package, lock, and manifest", () => {
  assert.doesNotThrow(() =>
    assertOnlyVersionFilesChanged(" M openclaw.plugin.json\n M package-lock.json\n M package.json\n"),
  );
  assert.doesNotThrow(() =>
    assertOnlyVersionFilesChanged("M openclaw.plugin.json\n M package-lock.json\n M package.json"),
  );
  assert.throws(() => assertOnlyVersionFilesChanged(" M package.json\n M index.ts\n"), /unexpected files/);
  assert.throws(() => assertOnlyVersionFilesChanged("not porcelain"), /invalid git porcelain record/);
});

test("resume state must match current package and repository identity", () => {
  const identity = {
    packageName: "@unblocklabs/slack-subagent-card",
    version: "1.2.15",
    pluginId: "slack-subagent-card",
    repository: "unblocklabs-ai/slack-subagent-card",
    openclawVersion: "2026.7.2-beta.3",
  };
  const state = {
    schemaVersion: 1,
    ...identity,
    defaultBranch: "main",
    tag: "v1.2.15",
    previousVersion: "1.2.14",
    baseCommit: "a".repeat(40),
    releaseCommit: "b".repeat(40),
    tarball: "/tmp/package.tgz",
    integrity: "sha512-value",
    shasum: "d".repeat(40),
    sha256: "e".repeat(64),
    committedFiles: {
      "openclaw.plugin.json": "a".repeat(64),
      "package-lock.json": "b".repeat(64),
      "package.json": "c".repeat(64),
    },
  };
  assert.equal(validateResumeIdentity(state, identity, "main"), state);
  assert.throws(
    () => validateResumeIdentity({ ...state, repository: "attacker/repo" }, identity, "main"),
    /does not match current metadata/,
  );
  assert.throws(
    () => validateResumeIdentity({ ...state, releaseCommit: "" }, identity, "main"),
    /missing releaseCommit/,
  );
});
