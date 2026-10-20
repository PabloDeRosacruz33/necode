#!/usr/bin/env bash
# Installs a Necode build on this Mac (the shared Mac mini) in one safe attempt, for people who
# use it remotely from laptops and phones:
#
#   1. Waits until no agent is working (no running turn) for two checks in a row, up to 45
#      minutes; if agents never stop, it installs nothing.
#   2. Quits Necode normally. Only the app itself and its server port count as "open": helpers
#      the app's binary keeps running on its own (the agent-device daemon) do not block.
#   3. Swaps the app, keeping the previous one, and checks the server answers again. If it does
#      not, it puts the previous app back.
#   4. Whatever happens, Necode is open again at the end, and the outcome is written to
#      ~/.cache/necode-install/last-result.txt (and the full log next to it).
#
# It runs exactly once: `schedule` hands it to launchd as a job with KeepAlive off, which
# launchd never restarts (unlike `launchctl submit`, which relaunches a job every time it exits),
# and the job removes itself when done.
#
# Usage: scripts/necode/install-mac-app.sh schedule /path/to/Necode.app
set -uo pipefail

LABEL="pro.necora.necode.install-once"
STATE="$HOME/.cache/necode-install"
INSTALLED="/Applications/Necode.app"
# Orchestration v2 (since the October 2026 T3 Code merge); state.sqlite no longer tracks runs.
DB="$HOME/.necode/userdata/statev2.sqlite"
PORT=3773

log() { echo "$(date '+%F %T') $*" >>"$STATE/install.log"; }
result() {
  echo "$(date '+%F %T') $*" >"$STATE/last-result.txt"
  log "RESULT: $*"
}
app_version() { /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null; }
app_running() { osascript -e 'application "Necode" is running' 2>/dev/null | grep -q true; }
port_listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }
server_answers() { [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/.well-known/t3/environment")" = 200 ]; }
running_turns() { sqlite3 -readonly "$DB" "select count(*) from orchestration_v2_projection_runs where status = 'running';" 2>/dev/null || echo 0; }
wait_until() { # seconds, condition...
  local deadline=$((SECONDS + $1)); shift
  until "$@"; do [ "$SECONDS" -ge "$deadline" ] && return 1; sleep 2; done
}
not() { ! "$@"; }
done_job() {
  rm -f "$STATE/$LABEL.plist"
  launchctl remove "$LABEL" 2>/dev/null
  exit 0
}

schedule() {
  local staged="$1"
  [ -d "$staged" ] || { echo "No app at $staged" >&2; exit 1; }
  codesign --verify --deep --strict "$staged" || { echo "$staged is not validly signed" >&2; exit 1; }
  if launchctl list "$LABEL" >/dev/null 2>&1; then
    echo "An installation is already scheduled ($LABEL). Remove it first: launchctl remove $LABEL" >&2
    exit 1
  fi
  mkdir -p "$STATE"
  cat >"$STATE/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$(cd "$(dirname "$0")" && pwd)/$(basename "$0")</string>
    <string>run</string><string>$staged</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$STATE/install.log</string>
  <key>StandardErrorPath</key><string>$STATE/install.log</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$STATE/$LABEL.plist"
  echo "Scheduled installing $(app_version "$staged") once. Outcome: $STATE/last-result.txt"
}

run() {
  local staged="$1" target
  target="$(app_version "$staged")"
  log "Installing $target over $(app_version "$INSTALLED")"
  # macOS checks a new app in full the first time it opens (Gatekeeper), which can take minutes;
  # do it now, while Necode still runs, so the swapped app opens at once (2026-10-20: 0.1.58 did
  # not answer within two minutes and was rolled back).
  spctl --assess --type execute "$staged" >>"$STATE/install.log" 2>&1 \
    || log "Gatekeeper did not accept $staged; installing anyway."

  # 1. Not while anyone's agent is working.
  local idle=0 deadline=$((SECONDS + 45 * 60))
  while [ "$idle" -lt 2 ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      result "NOT INSTALLED: agents kept working for 45 minutes. Nothing was changed."
      done_job
    fi
    if [ "$(running_turns)" = 0 ]; then idle=$((idle + 1)); else idle=0; fi
    [ "$idle" -lt 2 ] && sleep 60
  done

  # 2. Quit normally; the app and its server port are what must be gone.
  log "No agent working. Quitting Necode."
  osascript -e 'tell application "Necode" to quit' >/dev/null 2>&1
  if ! wait_until 120 not app_running || ! wait_until 30 not port_listening; then
    open "$INSTALLED"
    result "NOT INSTALLED: Necode did not quit within two minutes. Nothing was changed; Necode is open."
    done_job
  fi

  # 3. Swap, keeping the previous app, and check the server comes back.
  rm -rf "$STATE/previous" && mkdir -p "$STATE/previous"
  if ! mv "$INSTALLED" "$STATE/previous/Necode.app"; then
    open "$INSTALLED"
    result "NOT INSTALLED: could not move the current app aside. Nothing was changed; Necode is open."
    done_job
  fi
  if ditto "$staged" "$INSTALLED" && codesign --verify --deep --strict "$INSTALLED"; then
    open "$INSTALLED"
    if wait_until 300 server_answers; then
      result "INSTALLED $target. The previous app is in $STATE/previous."
      done_job
    fi
    log "The new version's server did not answer within five minutes; rolling back."
    osascript -e 'tell application "Necode" to quit' >/dev/null 2>&1
    wait_until 60 not app_running
  fi
  rm -rf "$INSTALLED"
  mv "$STATE/previous/Necode.app" "$INSTALLED"
  open "$INSTALLED"
  result "ROLLED BACK: $target did not start correctly. The previous version $(app_version "$INSTALLED") is open again."
  done_job
}

case "${1:-}" in
  schedule) schedule "${2:?Usage: $0 schedule /path/to/Necode.app}" ;;
  run) run "${2:?}" ;;
  *) echo "Usage: $0 schedule /path/to/Necode.app" >&2; exit 1 ;;
esac
