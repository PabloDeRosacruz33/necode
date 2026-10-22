import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * While it exists Claude refuses `--strict-mcp-config` and exits before
 * initializing, but it already ignores user, project and `--mcp-config` servers
 * on its own, so callers that pass the flag for isolation can drop it. Paths
 * match the ones Claude Code checks.
 */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

/** Accounts that share sessions continue threads from the default Claude home. */
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> & { readonly shareSessions?: boolean },
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(
      config.shareSessions ? { homePath: "" } : config,
      environment,
    );
    return `claude:home:${resolvedHomePath}`;
  },
);

/**
 * Point an account's `projects` directory, where Claude keeps resumable
 * transcripts, at the default Claude home. The account keeps its own login and
 * settings. An existing `projects` entry is left alone so real history is never
 * replaced.
 */
export const linkClaudeSharedSessions = Effect.fn("linkClaudeSharedSessions")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const accountHome = yield* resolveClaudeHomePath(config, environment);
  const sharedHome = yield* resolveClaudeHomePath({ homePath: "" }, environment);
  if (accountHome === sharedHome) return;
  const target = path.join(sharedHome, "projects");
  const link = path.join(accountHome, "projects");
  yield* fileSystem.makeDirectory(accountHome, { recursive: true });
  yield* fileSystem.makeDirectory(target, { recursive: true });
  if (yield* fileSystem.exists(link)) return;
  yield* fileSystem.symlink(target, link);
});

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. Sign in to this Claude instance in Settings > Providers, or run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};

export class ClaudeTranscriptCopyError extends Schema.TaggedError<ClaudeTranscriptCopyError>()(
  "ClaudeTranscriptCopyError",
  { sessionId: Schema.String, expectedBytes: Schema.Number, copiedBytes: Schema.Number },
) {
  override get message(): string {
    return `Copied ${this.copiedBytes} of ${this.expectedBytes} bytes of Claude session ${this.sessionId}.`;
  }
}

/** Claude keeps a folder's transcripts under `projects/<path with every non-alphanumeric as ->`. */
export const claudeProjectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Claude only resumes a session whose transcript sits under the current folder's project
 * directory, and it names that directory after the folder's physical path: it resolves links, so
 * a task under `~/.necode/worktrees` (a link to the external disk) lives under `-Volumes-…`. When
 * a thread moves to another folder (a merged permanent task's next version, a continued task, a
 * relocated repository), copy the transcript there so the conversation carries on.
 *
 * Every move leaves a copy behind, and a copy's date is when it was copied, so the current one is
 * the largest (transcripts only grow), then the newest. The session's side folder (subagent
 * transcripts, tool results) goes with it. Returns whether it copied.
 */
export const ensureClaudeTranscriptForCwd = Effect.fn("ensureClaudeTranscriptForCwd")(
  function* (input: {
    readonly claudeHome: string;
    readonly cwd: string;
    readonly sessionId: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsDir = path.join(input.claudeHome, "projects");
    const fileName = `${input.sessionId}.jsonl`;
    const physicalCwd = yield* fileSystem
      .realPath(input.cwd)
      .pipe(Effect.orElseSucceed(() => input.cwd));
    const targetDir = path.join(projectsDir, claudeProjectDirName(physicalCwd));
    const target = path.join(targetDir, fileName);
    if (yield* fileSystem.exists(target)) return false;
    let best: { readonly dir: string; readonly size: number; readonly mtime: number } | null = null;
    for (const entry of yield* fileSystem.readDirectory(projectsDir)) {
      const dir = path.join(projectsDir, entry);
      const info = yield* fileSystem.stat(path.join(dir, fileName)).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const size = Number(info.value.size);
      const mtime = Option.match(info.value.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      if (best === null || size > best.size || (size === best.size && mtime > best.mtime)) {
        best = { dir, size, mtime };
      }
    }
    if (best === null) return false;
    yield* fileSystem.makeDirectory(targetDir, { recursive: true });
    yield* fileSystem.copyFile(path.join(best.dir, fileName), target);
    const sideFolder = path.join(best.dir, input.sessionId);
    if (yield* fileSystem.exists(sideFolder)) {
      yield* fileSystem.copy(sideFolder, path.join(targetDir, input.sessionId), {
        overwrite: true,
      });
    }
    const copied = yield* fileSystem.stat(target).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => -1),
    );
    if (copied !== best.size) {
      // A partial copy would resume a truncated conversation; leave Claude to report it instead.
      yield* fileSystem.remove(target).pipe(Effect.ignore);
      return yield* new ClaudeTranscriptCopyError({
        sessionId: input.sessionId,
        expectedBytes: best.size,
        copiedBytes: copied,
      });
    }
    return true;
  },
);
