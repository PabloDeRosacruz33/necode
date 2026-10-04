/**
 * Opens on this phone the web pages that agents, terminals and scripts open on a connected
 * environment for this person's work, while the app is in front. Pages on the server's own
 * localhost cannot load here, so they are left for the desktop app (or the server) to take.
 */
import { createOpenUrlEnvironmentAtoms } from "@t3tools/client-runtime/state/open-url";
import type { EnvironmentId } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

const openUrlEnvironment = createOpenUrlEnvironmentAtoms(connectionAtomRuntime);

function opensOnPhone(url: string): boolean {
  try {
    return !isLocalLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function OpenUrlHosts() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <OpenUrlHost key={environment.environmentId} environmentId={environment.environmentId} />
      ))}
    </>
  );
}

function OpenUrlHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const ack = useAtomCommand(openUrlEnvironment.ack, { reportFailure: false });
  useEffect(() => {
    const handled = new Set<string>();
    return appAtomRegistry.subscribe(
      openUrlEnvironment.requests({ environmentId, input: {} }),
      (result) => {
        if (!AsyncResult.isSuccess(result) || handled.has(result.value.requestId)) return;
        const { requestId, url } = result.value;
        handled.add(requestId);
        // Without a confirmation the server tries the next device, then its own screen.
        if (AppState.currentState !== "active" || !opensOnPhone(url)) return;
        void tryOpenExternalUrl(url, "open-url-request").then((opened) => {
          if (opened) void ack({ environmentId, input: { requestId } });
        });
      },
      { immediate: true },
    );
  }, [ack, environmentId]);
  return null;
}
