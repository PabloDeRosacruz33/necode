import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Ports of remote environments the desktop app currently forwards to this Mac's localhost
 * (see components/preview/PortForwards.tsx). Read when turning an environment port into a URL.
 */
const forwarded = new Map<EnvironmentId, ReadonlySet<number>>();

export function setForwardedPorts(environmentId: EnvironmentId, ports: ReadonlySet<number>): void {
  if (ports.size === 0) forwarded.delete(environmentId);
  else forwarded.set(environmentId, ports);
}

export function isPortForwarded(environmentId: EnvironmentId, port: number): boolean {
  return forwarded.get(environmentId)?.has(port) ?? false;
}
