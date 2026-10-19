#!/usr/bin/env bash
# Checks the features Necode adds on top of T3 Code: team (invites, presence, who sent each
# message, commits signed as that person), pages opened on the person's device, tasks and their
# merge flow, Simular and the Device panel, disk space, voice, Claude accounts.
#
# Run it after bringing in T3 Code upstream and before publishing: the release scripts run it
# first and stop if it fails. An upstream merge can silently unhook these features (the October
# 2026 one dropped commit signing and message names) without breaking any upstream test.
#
# When you add a Necode feature, add its test file here.
#
# Usage: scripts/necode/check-necode.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VP="$ROOT/node_modules/.bin/vp"

# Run like a plain terminal: inside a Necode agent, the `git`/`open` stand-ins would sign the
# tests' throwaway commits as the thread's person.
unset NECODE_OPEN_URL_ENDPOINT NECODE_OPEN_URL_TOKEN NECODE_THREAD_ID BROWSER \
  GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/open-url/bin$' | paste -sd: -)"

run() { # package dir, test files...
  local dir="$1"
  shift
  echo "== $dir"
  (cd "$ROOT/$dir" && "$VP" test run "$@")
}

run apps/server \
  src/team/TeamService.test.ts \
  src/openUrl/OpenUrlBroker.test.ts \
  src/openUrl/openUrlEnvironment.test.ts \
  src/orchestration-v2/ProviderSessionManager.test.ts \
  src/orchestration-v2/ThreadLaunchService.test.ts \
  src/orchestration-v2/legacy/LegacyV1ThreadImporter.test.ts \
  src/persistence/Migrations/064_BackfillMessageAuthors.test.ts \
  src/device/ClientDeviceHosts.test.ts \
  src/diskSpace/DiskSpace.test.ts \
  src/macApp/iosSimulatorPlan.test.ts \
  src/macApp/macApp.test.ts \
  src/project/ProjectRelocation.test.ts \
  src/project/dependencyClone.test.ts \
  src/project/iconComposer.test.ts \
  src/project/worktreeDependencies.test.ts \
  src/provider/ClaudeAuth.test.ts \
  src/provider/forkResumeCursor.test.ts \
  src/shutdownSignals.test.ts \
  src/socketGuards.test.ts \
  src/vcs/mergeTaskCheck.test.ts \
  src/vcs/taskBranch.test.ts \
  src/vcs/taskReview.test.ts \
  src/voice/VoiceTranscription.test.ts

run apps/web \
  src/components/git/commitGraph.logic.test.ts \
  src/components/git/gitPanel.logic.test.ts

run apps/mobile \
  src/lib/threadActivity.test.ts

run packages/client-runtime \
  src/state/team.test.ts \
  src/state/threadStatus.test.ts \
  src/threadHandoff.test.ts

run packages/shared \
  src/macApp.test.ts \
  src/streamMux.test.ts

echo "Necode checks passed."
