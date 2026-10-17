import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Per-thread variables: pages the agent opens go to the person's device (openUrlEnvironment.ts)
   * and its commits are signed as the thread's person. Its `PATH` is a directory to put first.
   */
  readonly threadEnvironment?: Readonly<Record<string, string>>;
}

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

/** Adds per-thread variables; their `PATH` goes in front of the inherited one. */
function withPathPrefix(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | null | undefined,
): NodeJS.ProcessEnv {
  if (!extra) return base;
  const { PATH: prefix, ...rest } = extra;
  const current = base.PATH ?? base.Path;
  return {
    ...base,
    ...rest,
    ...(prefix ? { PATH: current ? `${prefix}:${current}` : prefix } : {}),
  };
}
