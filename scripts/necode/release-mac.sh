#!/usr/bin/env bash
# Builds, signs, notarizes and publishes a Necode macOS release to GitHub Releases.
# Installed copies find it through their built-in updater (Settings shows "Update").
#
# Usage: scripts/necode/release-mac.sh [version]
#   version defaults to the latest GitHub release with its patch number bumped.
# Needs: ~/.config/necode/asc.env (App Store Connect API key, used for notarization),
#        a Developer ID Application certificate in the keychain, gh logged in.
set -euo pipefail

REPO="PabloDeRosacruz33/necode"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:/opt/homebrew/opt/node@24/bin:$PATH"

set -a
# shellcheck disable=SC1090
. "$HOME/.config/necode/asc.env"
set +a

if [ "${1:-}" != "" ]; then
  VERSION="$1"
else
  LATEST="$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
  LATEST="${LATEST#v}"
  if [ -z "$LATEST" ]; then
    VERSION="0.1.0"
  else
    IFS=. read -r MAJOR MINOR PATCH <<<"$LATEST"
    VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
  fi
fi
echo "Releasing Necode $VERSION"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first: the release is built from HEAD." >&2
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$BRANCH"

export APPLE_API_KEY="$ASC_KEY_PATH" APPLE_API_KEY_ID="$ASC_KEY_ID" APPLE_API_ISSUER="$ASC_ISSUER_ID"
export T3CODE_DESKTOP_SIGNED=true T3CODE_DESKTOP_UPDATE_REPOSITORY="$REPO"
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version "$VERSION"

ASSETS=(
  "release/Necode-$VERSION-arm64.dmg"
  "release/Necode-$VERSION-arm64.dmg.blockmap"
  "release/Necode-$VERSION-arm64.zip"
  "release/Necode-$VERSION-arm64.zip.blockmap"
  "release/latest-mac.yml"
)
for asset in "${ASSETS[@]}"; do
  [ -f "$asset" ] || { echo "Missing build output: $asset" >&2; exit 1; }
done

gh release create "v$VERSION" "${ASSETS[@]}" \
  --repo "$REPO" \
  --target "$(git rev-parse HEAD)" \
  --title "Necode $VERSION" \
  --notes "Necode $VERSION for macOS (Apple silicon)."
echo "Published v$VERSION. Installed copies will offer the update."
