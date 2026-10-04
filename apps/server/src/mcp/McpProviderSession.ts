import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { withPathPrefix } from "../openUrl/openUrlEnvironment.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Per-thread variables: pages the agent opens go to the person's device (openUrlEnvironment.ts)
   * and its commits are signed as the thread's person. Its `PATH` is a directory to put first.
   */
  readonly threadEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device and per-thread variables applied over `base`. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | Pick<McpProviderSessionConfig, "agentDeviceEnvironment" | "threadEnvironment">
    | undefined,
): NodeJS.ProcessEnv {
  return withDeviceVariables(withPathPrefix(base, config?.threadEnvironment), config);
}

function withDeviceVariables(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
