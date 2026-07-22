# Releasing

There is one release workflow:

```sh
npm run release -- X.Y.Z
```

Run it from a clean checkout of the repository's GitHub default branch after all code changes are merged. `scripts/release.sh` is only a compatibility launcher for the same Node workflow.

## Local Validation

Install exactly from the committed lockfile and run the non-publishing gate:

```sh
npm ci
npm run preflight
npm run metadata:check -- X.Y.Z
git diff --check
```

`metadata:check` validates local package, manifest, lockfile, repository, and target-version shape without authentication, remote-state checks, or mutation. `preflight` may rebuild ignored `dist/` and write ignored reports and temporary OpenClaw state, but it does not mutate Git, npm, or GitHub.

## Release Invariants

The workflow derives the npm package, plugin ID, GitHub repository, and default branch from committed metadata. It refuses to release unless:

- `package.json`, `package-lock.json`, and `openclaw.plugin.json` have matching package identity and version data
- `openclaw.install.npmSpec` matches the package name and npm is the declared publication surface
- the worktree is clean and checked out on the GitHub default branch at the exact remote head
- every configured `origin` fetch and push URL matches `package.json.repository`
- GitHub and npm authentication work and the npm registry is `https://registry.npmjs.org/`
- the stable target is greater than the current version and every version already published to npm
- the exact npm target, local tag, remote tag, and GitHub release are absent
- `npm ci` and the complete preflight pass

Network, authorization, and malformed-response failures are not interpreted as absence.

## Publication Order

After all absence and compatibility checks pass, the workflow:

1. updates the version in the package, lockfile, and plugin manifest
2. reruns `npm ci` and the complete preflight against that candidate
3. commits those three version files, verifies the direct parent, exact committed file set, and pre-commit bytes after hooks run, then creates an annotated local tag
4. creates one npm tarball and runs the isolated `npm-pack:` OpenClaw install/runtime smoke against those exact bytes
5. refetches every npm version, rechecks monotonicity and exact npm/Git/GitHub absence, then performs an atomic-push dry run
6. publishes that exact tarball to npm
7. waits for npm and verifies its integrity and shasum against the inspected tarball
8. pushes the release commit and tag together with `git push --atomic`
9. creates the GitHub release and attaches the exact npm tarball

The workflow never falls back to split or force pushes. There is an unavoidable race between immutable npm publication and the following Git push; the immediate recheck, atomic push, and retained state make this visible and recoverable rather than silently inconsistent.

## Recovery

Release state is retained under `.release/vX.Y.Z/release-state.json`. Do not delete or modify the tarball after npm publication.

After inspecting the state, resume with:

```sh
npm run release -- --resume X.Y.Z
```

Resume first re-derives current package/repository/default-branch identity, validates every fetch and push URL, authentication, canonical registry, release commit bytes and parent, annotated local tag, and the saved tarball's package/plugin/OpenClaw identity plus all three digests. It then checks every external surface before acting:

- if npm does not contain the version, the saved exact tarball is the only artifact it may publish
- if npm contains matching integrity and shasum, it never republishes and continues with Git
- if npm contains different bytes, it stops for manual incident handling
- if the remote branch and tag are both absent in the expected pre-push state, it retries the atomic push
- if branch/tag state is partial, moved, or mismatched, it stops without force or split pushes
- if Git is correct and the GitHub release is absent, it creates only the GitHub release

If validation failed before a complete committed/tagged/tarred candidate exists, the resume command intentionally refuses to guess. Inspect the retained state and local version changes; abandon or repair them manually only after confirming npm, the remote tag, and the GitHub release are absent.

Once npm contains a matching version, npm's immutable tarball is authoritative. Never bump, overwrite, or rebuild that version during recovery.

## Verification

After completion, verify the npm package integrity, remote default-branch commit, annotated tag target, and GitHub release against `.release/vX.Y.Z/release-state.json`. If a local OpenClaw installation should consume npm, also ensure its config is not overriding the package with a checkout in `plugins.load.paths`.
