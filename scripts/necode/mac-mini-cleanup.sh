#!/usr/bin/env bash
# Keeps the shared Mac mini's internal disk from filling up. Repositories and task folders live on
# the external disk, but builds and agents still leave scratch behind on the internal one: copies
# of staging and iOS archives in /tmp, Xcode's upload pipelines in $TMPDIR, simulator builds. On
# 2026-10-20 that was 50 GB in a few days.
#
# Every night it removes what is regenerable and no longer in use:
#   - /private/tmp, $TMPDIR and /Volumes/NecoraDev/tmp entries older than 2 days that no process
#     has open (system folders in $TMPDIR are left alone);
#   - Xcode DerivedData folders unused for 7 days (DerivedData itself lives on the external disk);
#   - simulators whose runtime is gone.
# It logs what it freed to ~/.cache/necode-cleanup/cleanup.log.
#
# Usage:
#   scripts/necode/mac-mini-cleanup.sh install   copies itself to ~/.cache/necode-cleanup (launchd
#                                                cannot read /Volumes) and runs there every night
#   scripts/necode/mac-mini-cleanup.sh run       cleans now
set -uo pipefail

LABEL="pro.necora.necode.cleanup"
STATE="$HOME/.cache/necode-cleanup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
EXTERNAL_TMP="/Volumes/NecoraDev/tmp"
DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData"
# launchd jobs may not get TMPDIR; ask macOS for the per-user temp folder.
TMPDIR="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"

log() { echo "$(date '+%F %T') $*" >>"$STATE/cleanup.log"; }
free_gb() { df -k /System/Volumes/Data | awk 'NR==2 { printf "%.1f", $4 / 1048576 }'; }

install() {
  mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
  cp "$0" "$STATE/mac-mini-cleanup.sh"
  chmod +x "$STATE/mac-mini-cleanup.sh"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$STATE/mac-mini-cleanup.sh</string><string>run</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$STATE/launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE/launchd.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed: runs every night at 05:00. Log: $STATE/cleanup.log"
}

run() {
  mkdir -p "$STATE"
  local before open
  before="$(free_gb)"
  # Top-level temp entries some process still uses (a running build, a dev server's log).
  open="$(lsof -Fn 2>/dev/null | sed -n 's/^n//p' |
    sed -E "s#^(/private)?/tmp/([^/]+).*#/private/tmp/\2#; s#^(${TMPDIR%/}/[^/]+).*#\1#; s#^($EXTERNAL_TMP/[^/]+).*#\1#" |
    sort -u)"
  local dir entry name
  for dir in /private/tmp "${TMPDIR%/}" "$EXTERNAL_TMP"; do
    [ -d "$dir" ] || continue
    while IFS= read -r entry; do
      name="$(basename "$entry")"
      # $TMPDIR also holds macOS services' own folders; there, only what builds and agents make.
      if [ "$dir" = "${TMPDIR%/}" ]; then
        case "$name" in
          necora-* | necode-* | t3-* | t3code* | tmp.* | TemporaryDirectory.* | XcodeDistPipeline.* | \
            ibtoold-* | expo-* | metro-* | haste-map-* | vite-* | playwright* | electron-*) ;;
          *) continue ;;
        esac
      fi
      case "$name" in .*) continue ;; esac
      grep -qxF "$entry" <<<"$open" && continue
      rm -rf "$entry" && log "removed $entry"
    done < <(find "$dir" -maxdepth 1 -mindepth 1 -user "$(id -un)" -mtime +2 2>/dev/null)
  done
  if [ -d "$DERIVED_DATA/" ]; then
    find "$DERIVED_DATA/" -maxdepth 1 -mindepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null
  fi
  xcrun simctl delete unavailable >/dev/null 2>&1 || true
  log "free before ${before} GB, after $(free_gb) GB"
}

case "${1:-}" in
  install) install ;;
  run) run ;;
  *) echo "Usage: $0 install | run" >&2; exit 1 ;;
esac
