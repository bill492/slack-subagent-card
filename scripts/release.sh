#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 X.Y.Z" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

if [[ $# -ne 1 ]]; then
  usage
fi

VERSION="$1"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like X.Y.Z" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGE_NAME="@unblocklabs/slack-subagent-card"
TAG="v${VERSION}"

cd "$REPO_ROOT"

require_cmd git
require_cmd npm
require_cmd node
require_cmd gh

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to release with a dirty worktree." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Release must run from main. Current branch: ${CURRENT_BRANCH}" >&2
  exit 1
fi

git fetch origin --tags

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo "Local main does not match origin/main. Pull or reconcile before releasing." >&2
  exit 1
fi

gh auth status -h github.com >/dev/null
npm whoami >/dev/null

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists locally." >&2
  exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
PLUGIN_VERSION="$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('openclaw.plugin.json','utf8'));process.stdout.write(data.version)")"
if [[ "$CURRENT_VERSION" != "$PLUGIN_VERSION" ]]; then
  echo "Version mismatch: package.json=${CURRENT_VERSION}, openclaw.plugin.json=${PLUGIN_VERSION}" >&2
  exit 1
fi

if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  echo "Current version is already ${VERSION}. Choose a new version." >&2
  exit 1
fi

PUBLISHED_VERSION="$(npm view "${PACKAGE_NAME}" version 2>/dev/null || true)"
if [[ "$PUBLISHED_VERSION" == "$VERSION" ]]; then
  echo "npm already reports ${PACKAGE_NAME}@${VERSION}. This needs manual recovery, not a normal release." >&2
  exit 1
fi

if gh release view "$TAG" --repo bill492/slack-subagent-card >/dev/null 2>&1; then
  echo "GitHub release ${TAG} already exists. This needs manual recovery, not a normal release." >&2
  exit 1
fi

npm run check
npm test

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Tests or build changed tracked files. Commit those changes before releasing." >&2
  git status --short
  exit 1
fi

node -e "const fs=require('fs'); for (const file of ['package.json','openclaw.plugin.json']) { const data=JSON.parse(fs.readFileSync(file,'utf8')); data.version=process.argv[1]; fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }" "$VERSION"

git add package.json openclaw.plugin.json
git commit -m "Release slack-subagent-card ${TAG}"
git tag "$TAG"

git push origin main
git push origin "refs/tags/${TAG}"

npm publish --access public
gh release create "$TAG" --repo bill492/slack-subagent-card --title "$TAG" --generate-notes

for _ in 1 2 3 4 5; do
  if [[ "$(npm view "${PACKAGE_NAME}" version 2>/dev/null || true)" == "$VERSION" ]]; then
    break
  fi
  sleep 2
done

FINAL_PUBLISHED_VERSION="$(npm view "${PACKAGE_NAME}" version 2>/dev/null || true)"
if [[ "$FINAL_PUBLISHED_VERSION" != "$VERSION" ]]; then
  echo "npm publish did not settle to ${VERSION}; got ${FINAL_PUBLISHED_VERSION:-<empty>}." >&2
  exit 1
fi

echo "Released ${PACKAGE_NAME}@${VERSION}"
echo "Tag: ${TAG}"
echo "GitHub release: https://github.com/bill492/slack-subagent-card/releases/tag/${TAG}"
