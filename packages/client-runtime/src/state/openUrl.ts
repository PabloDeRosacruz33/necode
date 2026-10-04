import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Web pages opened on an environment for this person's work. A device mounts `requests` for as
 * long as it should receive them, opens each one and confirms with `ack`.
 */
export function createOpenUrlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    requests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:open-url:requests",
      tag: WS_METHODS.openUrlConnect,
      // Requests are commands: drop the registration with its owner so none replays later.
      idleTtlMs: 0,
    }),
    ack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:open-url:ack",
      tag: WS_METHODS.openUrlAck,
    }),
  };
}
