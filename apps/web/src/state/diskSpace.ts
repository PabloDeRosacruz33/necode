import { createDiskSpaceEnvironmentAtoms } from "@t3tools/client-runtime/state/diskSpace";
import type { EnvironmentId, ServerDiskSpace } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const diskSpaceEnvironment = createDiskSpaceEnvironmentAtoms(connectionAtomRuntime);

/** An environment's disk space; null while loading or on servers that do not report it. */
export function useServerDiskSpace(environmentId: EnvironmentId | null): ServerDiskSpace | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : diskSpaceEnvironment.diskSpace({ environmentId, input: {} }),
  );
  return query.data ?? null;
}
