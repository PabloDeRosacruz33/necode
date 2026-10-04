/**
 * Desktop app on a Mac only: offers this Mac's simulators to every remote environment, so agents
 * there build and Metro runs there while the app runs in a Simulator window here (see
 * apps/server/src/device/ClientDeviceHosts.ts). Requests from the environment are carried out by
 * the main process through `desktopBridge.deviceHost`.
 */
import type { ClientDeviceHostRequest, EnvironmentId } from "@t3tools/contracts";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const ROUTE = "/api/client-device-host";
const TICKET_REFRESH_MS = 4 * 60_000;

const requestsAtom = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:client-device-host:requests",
  tag: WS_METHODS.clientDeviceHostConnect,
  // The registration is the host's lifetime there: drop it with this component.
  idleTtlMs: 0,
});
const respondCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:client-device-host:respond",
  tag: WS_METHODS.clientDeviceHostRespond,
});

/** Tunnel and tool URLs with a fresh ticket, as the Device panel's streams get theirs. */
const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: ROUTE });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`client-device-host-access:${environmentId}`)),
);

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export function ClientDeviceHosts() {
  const { environments } = useEnvironments();
  if (!isElectron || !isMac || !window.desktopBridge?.deviceHost) return null;
  return (
    <>
      {environments
        .filter(
          ({ entry }) =>
            entry.target._tag !== "PrimaryConnectionTarget" &&
            !isDesktopLocalConnectionTarget(entry.target),
        )
        .map((environment) => (
          <ClientDeviceHost
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ))}
    </>
  );
}

function ClientDeviceHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const respond = useAtomCommand(respondCommand, { reportFailure: false });

  useEffect(() => {
    const bridge = window.desktopBridge?.deviceHost;
    if (!bridge) return;
    const access = accessAtom(environmentId);
    const unmountAccess = appAtomRegistry.mount(access);
    const refresh = setInterval(() => appAtomRegistry.refresh(access), TICKET_REFRESH_MS);
    const currentAccess = () => {
      const result = appAtomRegistry.get(access);
      return AsyncResult.isSuccess(result) ? result.value : null;
    };
    const handle = async (request: ClientDeviceHostRequest) => {
      if (request._tag === "tunnel") {
        const ticket = currentAccess();
        if (!ticket) return;
        const query = new URLSearchParams(ticket.query).toString();
        await bridge.openTunnel({
          url: `${ticket.wsBase}/tunnel/${request.tunnelId}${query ? `?${query}` : ""}`,
          port: request.port,
        });
        return;
      }
      const result =
        request._tag === "exec"
          ? await bridge.exec({
              command: request.command,
              args: request.args,
              ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
              ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            })
          : await (async () => {
              const ticket = currentAccess();
              if (!ticket) return { stdout: "", stderr: "Not connected yet.", code: 1 };
              return bridge.installTools({
                toolsUrl: `${ticket.httpBase}/tools`,
                query: ticket.query,
                tools: request.tools,
              });
            })();
      await respond({ environmentId, input: { requestId: request.requestId, ...result } });
    };
    const handled = new Set<string>();
    const unsubscribe = appAtomRegistry.subscribe(
      requestsAtom({ environmentId, input: {} }),
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const request = result.value;
        const id = request._tag === "tunnel" ? request.tunnelId : request.requestId;
        if (handled.has(id)) return;
        handled.add(id);
        void handle(request);
      },
      { immediate: true },
    );
    return () => {
      unsubscribe();
      clearInterval(refresh);
      unmountAccess();
    };
  }, [environmentId, respond]);

  return null;
}
