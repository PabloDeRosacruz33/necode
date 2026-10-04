/**
 * Opens on this computer the web pages that agents, terminals and scripts open on a connected
 * environment for this person's work (logins, docs, the app being built), then confirms so the
 * server does not try another device. Only the desktop app takes them: a browser tab cannot
 * open pages without a click, so the server keeps those on its own machine.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { createOpenUrlEnvironmentAtoms } from "@t3tools/client-runtime/state/open-url";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "./ui/toast";

const openUrlEnvironment = createOpenUrlEnvironmentAtoms(connectionAtomRuntime);

export function OpenUrlHosts() {
  const { environments } = useEnvironments();
  if (!isElectron || !window.desktopBridge) return null;
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
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const handled = new Set<string>();
    // Every request matters, so each stream value is handled as it arrives, not per render.
    return appAtomRegistry.subscribe(
      openUrlEnvironment.requests({ environmentId, input: {} }),
      (result) => {
        if (!AsyncResult.isSuccess(result) || handled.has(result.value.requestId)) return;
        const { requestId, url } = result.value;
        handled.add(requestId);
        void bridge.openExternal(url).then((opened) => {
          if (!opened) return;
          void ack({ environmentId, input: { requestId } });
          toastManager.add({ type: "info", title: "Abierto en tu navegador", description: url });
        });
      },
      { immediate: true },
    );
  }, [ack, environmentId]);
  return null;
}
