import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(NodeOS.homedir(), ".claude"));
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
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
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

/** Claude keeps a folder's transcripts under `projects/<path with every non-alphanumeric as ->`. */
export const claudeProjectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Claude only resumes a session whose transcript sits under the current folder's project
 * directory. When a thread moves to another folder (a new task, a relocated repository), copy
 * the transcript there from wherever it was written, so the conversation carries on.
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
    const targetDir = path.join(projectsDir, claudeProjectDirName(input.cwd));
    if (yield* fileSystem.exists(path.join(targetDir, fileName))) return false;
    for (const entry of yield* fileSystem.readDirectory(projectsDir)) {
      const candidate = path.join(projectsDir, entry, fileName);
      if (!(yield* fileSystem.exists(candidate))) continue;
      yield* fileSystem.makeDirectory(targetDir, { recursive: true });
      yield* fileSystem.copyFile(candidate, path.join(targetDir, fileName));
      return true;
    }
    return false;
  },
);
