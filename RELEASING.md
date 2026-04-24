# Releasing

This repo should be released by following one path only:

```sh
npm run release -- X.Y.Z
```

Run it from a clean `main` checkout after all code changes are already merged.

## Release Rules

- `main` is the only release source of truth.
- npm, the Git tag, the GitHub release, and `main` must all point at the same commit.
- Do not publish from an unmerged branch.
- Do not bump only one version file. `package.json` and `openclaw.plugin.json` must match.
- Do not leave local OpenClaw pointed at a repo checkout after a real release if the intended deploy path is npm.

## Normal Release Flow

1. Merge feature or fix branches into `main`.
2. Check out `main`.
3. Pull `origin/main` with `--ff-only`.
4. Run `npm run release -- X.Y.Z`.
5. Confirm GitHub `main`, tag `vX.Y.Z`, GitHub Releases, and npm all show the same version.

## What The Script Enforces

The release script refuses to continue unless all of these are true:

- the git worktree is clean
- the current branch is `main`
- local `main` matches `origin/main`
- `gh` authentication works
- `npm whoami` works
- the target version is new
- tests pass
- tests do not dirty tracked files before the version bump

## Manual Verification

After the script finishes, verify:

```sh
git rev-parse main
git rev-parse vX.Y.Z
npm view @unblocklabs/slack-subagent-card version
gh release view vX.Y.Z --repo bill492/slack-subagent-card
```

If local OpenClaw should consume the published package, also verify:

- `~/.openclaw/openclaw.json` uses `@unblocklabs/slack-subagent-card@X.Y.Z`
- `plugins.load.paths` is not still overriding the plugin with the repo checkout

## Recovery

If a release gets split across surfaces, fix it in this order:

1. make `main` correct
2. make the tag correct
3. make npm correct
4. make the GitHub release correct
5. delete stale release branches

If this flow changes, update `RELEASING.md` and `scripts/release.sh` together in the same PR.
