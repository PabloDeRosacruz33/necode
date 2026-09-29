#!/usr/bin/env bash
# Builds the Necode iOS app and uploads it to TestFlight. Testers in the internal
# "Equipo" group get it automatically; with TestFlight's Automatic Updates on,
# their phones install it without asking.
#
# Usage: scripts/necode/release-ios.sh
# Needs: ~/.config/necode/asc.env, Xcode, CocoaPods (brew install cocoapods).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE="$ROOT/apps/mobile"
WORK="$(mktemp -d)"
export PATH="/opt/homebrew/opt/node@24/bin:$PATH" LANG=en_US.UTF-8

set -a
# shellcheck disable=SC1090
. "$HOME/.config/necode/asc.env"
set +a

BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"
echo "Building Necode iOS, build $BUILD_NUMBER"

cd "$MOBILE"
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 pnpm exec expo prebuild --clean --platform ios >/dev/null
# Keep the generated native project and its Pods out of Dropbox sync.
xattr -w com.dropbox.ignored 1 ios 2>/dev/null || true

for plist in ios/Necode/Info.plist ios/ExpoWidgetsTarget/Info.plist ios/expo-sharing-extension/Info.plist; do
  [ -f "$plist" ] && /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$plist"
done
sed -i '' "s/CURRENT_PROJECT_VERSION = [0-9]*;/CURRENT_PROJECT_VERSION = $BUILD_NUMBER;/" ios/Necode.xcodeproj/project.pbxproj

AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

xcodebuild -workspace ios/Necode.xcworkspace -scheme Necode -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$WORK/Necode.xcarchive" archive \
  "${AUTH[@]}" DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic -quiet

cat >"$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>upload</string>
<key>teamID</key><string>$APPLE_TEAM_ID</string>
<key>signingStyle</key><string>automatic</string>
<key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$WORK/Necode.xcarchive" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" "${AUTH[@]}" -quiet

rm -rf "$WORK"
echo "Uploaded build $BUILD_NUMBER. It reaches TestFlight after Apple finishes processing (5 to 30 minutes)."
