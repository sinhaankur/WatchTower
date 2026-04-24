#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 1.2.1"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must use semantic format: X.Y.Z"
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Switch to main before tagging. Current branch: $CURRENT_BRANCH"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit/stash changes first."
  exit 1
fi

echo "Running tests before creating release tag ..."
python3 -m pip install --upgrade pip >/dev/null
python3 -m pip install -r requirements.txt >/dev/null
python3 -m pip install pytest >/dev/null
python3 -m pytest -q

PKG_VERSION=$(python3 - <<'PY'
from watchtower import __version__
print(__version__)
PY
)

if [[ "$PKG_VERSION" != "$VERSION" ]]; then
  echo "watchtower.__version__ ($PKG_VERSION) does not match requested version ($VERSION)"
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
  exit 1
fi

if git ls-remote --tags origin | grep -q "refs/tags/${TAG}$"; then
  echo "Tag $TAG already exists on origin."
  exit 1
fi

git pull --ff-only origin main
git tag -a "$TAG" -m "Release $TAG"
git push origin main
git push origin "$TAG"

echo "Release tag pushed: $TAG"
