import {
  createTeamEnvironmentAtoms,
  EMPTY_TEAM_SNAPSHOT,
} from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, TeamSnapshot } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

/** Live members and presence of an environment; empty while loading or on servers without teams. */
export function useTeamSnapshot(environmentId: EnvironmentId | null): TeamSnapshot {
  const query = useEnvironmentQuery(
    environmentId === null ? null : teamEnvironment.team({ environmentId, input: {} }),
  );
  return query.data ?? EMPTY_TEAM_SNAPSHOT;
}
