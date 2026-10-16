// @effect-diagnostics nodeBuiltinImport:off -- Activity ids come from the platform's UUID generator.
import * as NodeCrypto from "node:crypto";

import type {
  OrchestrationThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { CommandId, EventId, T3_PROJECT_FILE_NAME, type ThreadId } from "@t3tools/contracts";
import {
  configuredIntegrationBranch,
  resolveWorktreeCleanup,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { markWorktreeHibernated } from "./project/worktreeDependencies.ts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ThreadDeletionReactor from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import { threadHasQueuedTurnStart } from "./orchestration/ThreadSettlementPolicy.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const DAY_MS = 86_400_000;

/**
 * Ignored paths a task folder can always rebuild: installs, build output, setup links. The one
 * rule for what may go with a folder and what hibernation empties; anything else ignored
 * (secrets, local data) keeps a folder whole.
 */
export const REGENERABLE_IGNORED =
  /(^|\/)(node_modules|build|dist|dist-electron|out|\.next|\.turbo|\.expo|\.vite|\.vite-plus|\.cache|\.vercel|\.temp|ios|android|Pods|DerivedData|target|coverage)\/?$|\.tsbuildinfo$/;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeHibernateAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

/**
 * Nothing is happening in the thread. A `ready` session is a provider process waiting between
 * turns: it is stopped before its folder is removed, and a folder emptied under it is rebuilt
 * before its next turn.
 */
function storageCleanupThreadIdle(thread: OrchestrationThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    (thread.session === null ||
      thread.session.status === "stopped" ||
      thread.session.status === "ready" ||
      thread.session.status === "error") &&
    thread.latestTurn?.state !== "running" &&
    thread.backgroundLiveness == null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !threadHasQueuedTurnStart(thread, DateTime.formatIso(DateTime.makeUnsafe(now)))
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
function storageCleanupActivityAt(thread: OrchestrationThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ].flatMap((value) => (value == null ? [] : [Date.parse(value)])),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletion = yield* ThreadDeletionReactor.ThreadDeletionReactor;
  const providers = yield* ProviderService.ProviderService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /** The branch tasks merge into: t3.json or the project setting, else `staging` when it exists. */
  const integrationBranch = (
    serverSettings: ServerSettings,
    projectId: ProjectId | null,
    repositoryCwd: string,
  ) =>
    Effect.gen(function* () {
      const projectFile = parseT3ProjectFile(
        yield* fs
          .readFileString(path.join(repositoryCwd, T3_PROJECT_FILE_NAME))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      const configured = configuredIntegrationBranch(serverSettings, projectId, projectFile);
      if (configured) return configured;
      const staging = yield* git.execute({
        operation: "StorageCleanup.stagingBranch",
        cwd: repositoryCwd,
        args: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/staging"],
        allowNonZeroExit: true,
      });
      return staging.exitCode === 0 ? "staging" : null;
    }).pipe(Effect.orElseSucceed(() => null));
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  /**
   * A folder under the tasks root, which may itself be a link to another disk: the folder's
   * real path must differ from the recorded one only by that root. Threads, terminals and
   * provider sessions keep the recorded path, so that is what every comparison uses.
   */
  const isTaskFolder = Effect.fn("StorageCleanup.isTaskFolder")(function* (
    realRoot: string,
    worktreePath: string,
  ) {
    const configuredRoot = path.resolve(config.worktreesDir);
    if (!inside(configuredRoot, worktreePath) || !(yield* fs.exists(worktreePath))) return false;
    const real = yield* fs.realPath(worktreePath).pipe(Effect.orElseSucceed(() => null));
    return real === path.join(realRoot, path.relative(configuredRoot, worktreePath));
  });

  const sessionsIn = (threadId: string, worktreePath: string) =>
    providers
      .listSessions()
      .pipe(
        Effect.map((sessions) =>
          sessions.filter(
            (session) =>
              session.status !== "closed" &&
              (session.threadId === threadId ||
                (session.cwd !== undefined &&
                  (path.resolve(session.cwd) === worktreePath ||
                    inside(worktreePath, path.resolve(session.cwd))))),
          ),
        ),
      );

  /**
   * Stops a thread's idle provider session so its folder can go; false when a session is busy
   * or did not stop in time. ProviderRuntimeIngestion records the stop on the thread.
   */
  const releaseIdleSessions = Effect.fn("StorageCleanup.releaseIdleSessions")(function* (
    threadId: ThreadId,
    worktreePath: string,
  ) {
    const live = yield* sessionsIn(threadId, worktreePath);
    if (live.length === 0) return true;
    if (live.some((session) => session.status !== "ready" && session.status !== "error")) {
      return false;
    }
    yield* providers.stopSession({ threadId }).pipe(Effect.orElseSucceed(() => undefined));
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((yield* sessionsIn(threadId, worktreePath)).length === 0) return true;
      yield* Effect.sleep("250 millis");
    }
    return false;
  });

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* snapshots.getShellSnapshot();
    const archived = yield* snapshots.getArchivedShellSnapshot();
    return { projects: active.projects, threads: [...active.threads, ...archived.threads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    if (!(yield* fs.exists(config.worktreesDir))) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedThreads = hasDeleteRule
      ? (yield* snapshots.getDeletedWorktreeThreads()).filter(
          (thread) => resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
        )
      : [];
    if (deletedThreads.length > 0) {
      // Read tombstones before taking this fence. A later deletion waits for the
      // next sweep; every captured deletion must finish stopping its resources.
      const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
      yield* threadDeletion.drainThrough(snapshotSequence);
    }
    const snapshot = yield* readThreads();
    const root = yield* fs.realPath(config.worktreesDir);
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].flatMap((group) => (group.length === 1 ? [group[0]!] : [])),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "deletedAt" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      if (
        project === undefined ||
        (!deleted && !storageCleanupThreadIdle(thread, now)) ||
        hasTerminal(worktreePath)
      )
        continue;
      yield* Effect.gen(function* () {
        if (!(yield* isTaskFolder(root, worktreePath))) return;
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects])) return;
        // A linked worktree has a .git file. Never remove a main checkout.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.branch !== thread.branch || status.hasWorkingTreeChanges)
          return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const ignored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        // Ignored files can contain secrets or local datasets. Dependency installs, build output
        // and links the setup script makes are reproducible; any other ignored path prevents
        // automatic removal.
        if (
          ignored.stdoutTruncated ||
          ignored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !REGENERABLE_IGNORED.test(entry))
        )
          return;
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          // Tasks merge into the integration branch (staging), which is often not the default.
          const branch =
            (yield* integrationBranch(serverSettings, thread.projectId, repositoryCwd)) ??
            (yield* git.resolveDefaultBranchName(repositoryCwd, remote));
          if (branch === null) return;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0) return;
          // Everything in it is in the integration branch: unchanged, or merged there without a
          // pull request ("Fusionar", or an agent merging by hand) once the thread has been quiet
          // for a day; ProviderCommandReactor brings the folder back if the thread continues.
          eligible =
            settings.worktreeUnchanged ||
            (settings.worktreeOnMerge &&
              !("deletedAt" in thread) &&
              storageCleanupActivityAt(thread) < now - DAY_MS);
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = pullRequest?.state === "merged";
          }
        }
        if (!eligible) return;
        // Re-read after Git/host calls so a queued turn, resumed session or new
        // thread sharing this path cancels the removal.
        const latestSnapshot = yield* readThreads();
        if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects])) return;
        const latest = latestSnapshot.threads.filter(
          (entry) =>
            entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
        );
        if (hasTerminal(worktreePath)) return;
        if (deleted) {
          if (
            latest.length > 0 ||
            !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
              .worktreeOnDelete
          )
            return;
          // A failed session stop is logged by the deletion reactor. Its drain
          // alone is not proof that a provider released this checkout.
          if (
            (yield* providers.listSessions()).some(
              (session) =>
                session.status !== "closed" &&
                (session.threadId === thread.id ||
                  (session.cwd !== undefined &&
                    (path.resolve(session.cwd) === worktreePath ||
                      inside(worktreePath, path.resolve(session.cwd))))),
            )
          )
            return;
        } else if (
          latest.length !== 1 ||
          latest[0]!.id !== thread.id ||
          !storageCleanupThreadIdle(latest[0]!, now) ||
          storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
        )
          return;
        const finalStatus = yield* git.statusDetailsLocal(worktreePath);
        if (
          !finalStatus.isRepo ||
          finalStatus.branch !== thread.branch ||
          finalStatus.hasWorkingTreeChanges
        )
          return;
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return;
        const finalIgnored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        if (
          finalIgnored.stdoutTruncated ||
          finalIgnored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !REGENERABLE_IGNORED.test(entry))
        )
          return;
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        // A provider process idling in the folder would resume into a deleted directory. It is
        // stopped first; the thread's next turn starts it again in the recreated checkout.
        if (!deleted && !(yield* releaseIdleSessions(thread.id, worktreePath))) return;
        yield* git.removeWorktree({ cwd: project.workspaceRoot, path: worktreePath, force: false });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderCommandReactor recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  /**
   * Tasks nobody has touched for a while keep their code, commits and uncommitted changes but
   * lose what any checkout rebuilds: installs, build output, setup links, the bulk of a task
   * folder. The thread's next turn runs the setup script again first (ProviderCommandReactor).
   */
  const hibernateWorktrees = Effect.fn("StorageCleanup.hibernateWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (
      !anyWorktreePolicy(serverSettings, (rules) => rules.worktreeHibernateAfterDays !== null) ||
      !(yield* fs.exists(config.worktreesDir))
    )
      return;
    const snapshot = yield* readThreads();
    const root = yield* fs.realPath(config.worktreesDir);
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    for (const [worktreePath, threads] of groups) {
      const days = resolveWorktreeCleanup(
        serverSettings,
        threads[0]!.projectId,
      ).worktreeHibernateAfterDays;
      if (days === null) continue;
      const quietSince = now - days * DAY_MS;
      if (
        !threads.every(
          (thread) =>
            storageCleanupThreadIdle(thread, now) && storageCleanupActivityAt(thread) < quietSince,
        ) ||
        hasTerminal(worktreePath)
      )
        continue;
      yield* Effect.gen(function* () {
        if (!(yield* isTaskFolder(root, worktreePath))) return;
        if (yield* containsProjectRoot(worktreePath, snapshot.projects)) return;
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
        for (const thread of threads) {
          // A provider idling in the folder keeps running; it only reads code it asks for.
          if (
            (yield* sessionsIn(thread.id, worktreePath)).some(
              (session) => session.status !== "ready" && session.status !== "error",
            )
          )
            return;
        }
        const ignored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 256 * 1024,
        });
        if (ignored.stdoutTruncated) return;
        const removable = ignored.stdout
          .split("\0")
          .filter((entry) => entry !== "" && REGENERABLE_IGNORED.test(entry))
          .map((entry) => entry.replace(/\/$/, ""))
          .filter((entry) => inside(worktreePath, path.resolve(worktreePath, entry)));
        if (removable.length === 0) return;
        const gitDir = yield* git.execute({
          operation: "StorageCleanup.gitDir",
          cwd: worktreePath,
          args: ["rev-parse", "--absolute-git-dir"],
        });
        for (const entry of removable) {
          yield* fs.remove(path.resolve(worktreePath, entry), { recursive: true });
        }
        yield* markWorktreeHibernated(gitDir.stdout.trim());
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const shown = removable.slice(0, 4).join(", ") + (removable.length > 4 ? "…" : "");
        for (const thread of threads) {
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`server:worktree-hibernated:${thread.id}:${createdAt}`),
              threadId: thread.id,
              activity: {
                id: EventId.make(NodeCrypto.randomUUID()),
                tone: "info",
                kind: "task.hibernated",
                summary: `Tarea en reposo tras ${days} ${days === 1 ? "día" : "días"} sin actividad: se han retirado ${shown}. Se reinstalan al continuar.`,
                payload: { worktreePath, removed: removable },
                turnId: null,
                createdAt,
              },
              createdAt,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        yield* Effect.logInfo("storage cleanup hibernated worktree", {
          worktreePath,
          removed: removable,
        });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped hibernating worktree", { worktreePath, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* hibernateWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree hibernation failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = yield* engine.subscribeDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "thread.deleted" &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ),
    );
  });
  return { start, drain: worker.drain } satisfies StorageCleanup["Service"];
});

export const layer = Layer.effect(StorageCleanup, make);
