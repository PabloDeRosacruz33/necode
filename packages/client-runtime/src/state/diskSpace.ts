import { type ServerDiskSpace, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export function createDiskSpaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Free space on an environment's disk, pushed when its level or size changes. */
    diskSpace: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:disk-space",
      tag: WS_METHODS.subscribeServerDiskSpace,
    }),
  };
}

/** What to tell people about an environment's disk, or null while it has room. */
export function diskSpaceNotice(
  space: ServerDiskSpace | null | undefined,
  environmentLabel: string,
): { readonly severity: "warning" | "error"; readonly title: string } | null {
  if (!space || space.level === "ok") return null;
  const free = `${(space.freeBytes / 1e9).toLocaleString("es-ES", { maximumFractionDigits: 1 })} GB`;
  return space.level === "critical"
    ? {
        severity: "error",
        title: `A ${environmentLabel} solo le quedan ${free} libres: no se pueden crear tareas nuevas hasta liberar espacio`,
      }
    : { severity: "warning", title: `A ${environmentLabel} le quedan ${free} libres en el disco` };
}
