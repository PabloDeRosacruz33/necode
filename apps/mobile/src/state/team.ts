import {
  createTeamEnvironmentAtoms,
  EMPTY_TEAM_SNAPSHOT,
  isViewingThreadReported,
} from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, TeamSnapshot, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

/** Live members and presence of an environment; empty while loading or on servers without teams. */
export function useTeamSnapshot(environmentId: EnvironmentId): TeamSnapshot {
  const query = useEnvironmentQuery(teamEnvironment.team({ environmentId, input: {} }));
  return query.data ?? EMPTY_TEAM_SNAPSHOT;
}

/** Reports the open thread to the environment so teammates can see who is looking at it. */
export function useReportTeamViewing(environmentId: EnvironmentId, threadId: ThreadId) {
  const setViewing = useAtomCommand(teamEnvironment.setViewing, { reportFailure: false });
  const team = useTeamSnapshot(environmentId);
  // Resend whenever the environment lost track: first connect, reconnect, restart.
  const hasSnapshot = team.selfMemberId !== null;
  const reported = isViewingThreadReported(team, threadId);
  useEffect(() => {
    if (!hasSnapshot || reported) return;
    void setViewing({ environmentId, input: { threadId } });
  }, [environmentId, hasSnapshot, reported, setViewing, threadId]);
  useEffect(
    () => () => {
      void setViewing({ environmentId, input: { threadId: null } });
    },
    [environmentId, setViewing, threadId],
  );
}
