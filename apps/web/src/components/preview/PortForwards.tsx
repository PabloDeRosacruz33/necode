/**
 * Desktop app only: keeps every dev server a remote environment reports answering on this Mac's
 * own localhost, through the main process's port forwards (apps/desktop/src/portForward). Links,
 * previews and login callbacks to `localhost:<port>` then reach the environment unchanged.
 * The forwards' WebSocket tickets last five minutes, so the set is resent with fresh ones.
 */
import { useAtomValue } from "@effect/atom-react";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { setForwardedPorts } from "~/browser/portForwardState";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { environmentSession } from "~/state/session";

const PORT_FORWARD_ROUTE = "/api/port-forward";
const TICKET_REFRESH_MS = 4 * 60_000;

const portForwardAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: PORT_FORWARD_ROUTE });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`port-forward-access:${environmentId}`)),
);

/** Wanted forwards per environment; a port two environments report goes to the first. */
const wanted = new Map<EnvironmentId, ReadonlyArray<{ port: number; url: string }>>();
let syncing = Promise.resolve();

function syncForwards() {
  syncing = syncing.then(async () => {
    const sync = window.desktopBridge?.syncPortForwards;
    if (!sync) return;
    const owners = new Map<number, EnvironmentId>();
    const forwards: Array<{ port: number; url: string }> = [];
    for (const [environmentId, list] of wanted) {
      for (const forward of list) {
        if (owners.has(forward.port)) continue;
        owners.set(forward.port, environmentId);
        forwards.push(forward);
      }
    }
    const result = await sync({ forwards }).catch(() => []);
    const forwarding = new Map<EnvironmentId, Set<number>>();
    for (const { port, forwarding: active } of result) {
      const owner = owners.get(port);
      if (!active || owner === undefined) continue;
      forwarding.set(owner, (forwarding.get(owner) ?? new Set()).add(port));
    }
    for (const environmentId of new Set([...wanted.keys(), ...forwarding.keys()])) {
      setForwardedPorts(environmentId, forwarding.get(environmentId) ?? new Set());
    }
  });
}

export function PortForwards() {
  const { environments } = useEnvironments();
  if (!isElectron || !window.desktopBridge?.syncPortForwards) return null;
  return (
    <>
      {environments
        .filter(
          ({ entry }) =>
            entry.target._tag !== "PrimaryConnectionTarget" &&
            !isDesktopLocalConnectionTarget(entry.target),
        )
        .map((environment) => (
          <EnvironmentPortForwards
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ))}
    </>
  );
}

function EnvironmentPortForwards({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { servers } = useDiscoveredPortsState(environmentId);
  const accessResult = useAtomValue(portForwardAccessAtom(environmentId));
  const access = AsyncResult.isSuccess(accessResult) ? accessResult.value : null;
  const portsKey = useMemo(
    () => [...new Set(servers.map((server) => server.port))].sort((a, b) => a - b).join(","),
    [servers],
  );

  useEffect(() => {
    if (!access) return;
    const query = new URLSearchParams(access.query).toString();
    const ports = portsKey ? portsKey.split(",").map(Number) : [];
    wanted.set(
      environmentId,
      ports.map((port) => ({ port, url: `${access.wsBase}/${port}${query ? `?${query}` : ""}` })),
    );
    syncForwards();
  }, [access, environmentId, portsKey]);

  useEffect(() => {
    const refresh = setInterval(
      () => appAtomRegistry.refresh(portForwardAccessAtom(environmentId)),
      TICKET_REFRESH_MS,
    );
    return () => {
      clearInterval(refresh);
      wanted.delete(environmentId);
      syncForwards();
    };
  }, [environmentId]);

  return null;
}
