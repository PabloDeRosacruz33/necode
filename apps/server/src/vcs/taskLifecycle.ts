/**
 * Necode: a task's life after it is created. Its own branch and folder, its setup, moving a thread
 * to a new task, and finishing a merged task: closed, or for a permanent thread (`…-v<N>`)
 * continued in `…-v<N+1>`. The web's merge and continue dialogs and agents (t3_task_finish) use
 * the same steps, so a deploy that merges tasks leaves their threads where the dialog would.
 */
import {
  CommandId,
  GitCommandError,
  T3_PROJECT_FILE_NAME,
  type OrchestrationV2Command,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { configuredIntegrationBranch } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { cloneDependencies } from "../project/dependencyClone.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { recordWorktreeDependencies } from "../project/worktreeDependencies.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveTaskWorktree } from "./taskBranch.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

/** Tells a task's setup script that its dependencies were cloned and need no install. */
export const DEPENDENCIES_READY_ENV = { T3CODE_DEPENDENCIES_READY: "1" } as const;

/** `…-v<N>` is a permanent thread; its next task is `…-v<N+1>`. Null for other tasks. */
export function nextPermanentTaskName(branch: string): string | null {
  const name = branch.slice(branch.lastIndexOf("/") + 1);
  const match = /^(.+)-v(\d+)$/.exec(name);
  return match ? `${match[1]}-v${Number(match[2]) + 1}` : null;
}

const taskError = (cwd: string, detail: string) =>
  new GitCommandError({
    operation: "GitWorkflowService.prepareTask",
    command: "task worktree",
    cwd,
    detail,
  });

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const crypto = yield* Crypto.Crypto;
  const commandId = (tag: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
    );
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const withTaskServices = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | ProcessRunner.ProcessRunner
    >,
  ) => effect.pipe(Effect.provide(ProcessRunner.layer), Effect.provideContext(context));
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    withTaskServices(
      Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
        runner.run({ command: "git", args: ["-C", cwd, ...args] }),
      ),
    );

  const refreshGitStatus = (cwd: string) =>
    vcsStatus
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  /** The branch tasks start from and merge into, resolved the way the branch menu does. */
  const integrationRef = (projectCwd: string, projectId: ProjectId) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectFile = parseT3ProjectFile(
        yield* fs
          .readFileString(path.join(projectCwd, T3_PROJECT_FILE_NAME))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const configured = configuredIntegrationBranch(settings, projectId, projectFile);
      if (configured) return configured;
      const hasStaging = yield* gitWorkflow
        .remoteBranchExists({ cwd: projectCwd, remoteName: "origin", refName: "staging" })
        .pipe(Effect.orElseSucceed(() => false));
      if (hasStaging) return "staging";
      const head = yield* git(projectCwd, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]).pipe(
        Effect.map((output) => output.stdout.trim().replace(/^origin\//, "")),
        Effect.orElseSucceed(() => ""),
      );
      return head || "main";
    }).pipe(Effect.provideContext(context));

  /** A task's own branch and folder, from `baseRef` or else the integration branch's latest. */
  const prepareTaskWorktree = (input: {
    readonly projectCwd: string;
    readonly targetRef: string;
    readonly taskName: string;
    readonly branchPrefix?: string | undefined;
    readonly baseRef?: string | undefined;
  }) =>
    Effect.gen(function* () {
      let baseRef = input.baseRef;
      if (baseRef === undefined) {
        yield* gitWorkflow.fetchRemote({
          cwd: input.projectCwd,
          remoteName: "origin",
          refName: input.targetRef,
        });
        const hasRemote = yield* gitWorkflow.remoteBranchExists({
          cwd: input.projectCwd,
          remoteName: "origin",
          refName: input.targetRef,
        });
        baseRef = hasRemote
          ? (yield* gitWorkflow.resolveRemoteTrackingCommit({
              cwd: input.projectCwd,
              refName: input.targetRef,
              fallbackRemoteName: "origin",
            })).commitSha
          : input.targetRef;
      }
      // The tasks folder may live on an external disk through a link; without it no task starts.
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(config.worktreesDir).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* taskError(
          input.projectCwd,
          `La carpeta de tareas (${config.worktreesDir}) no está disponible. Si está en un disco externo, conéctalo.`,
        );
      }
      const task = yield* withTaskServices(
        resolveTaskWorktree({
          projectCwd: input.projectCwd,
          worktreesDir: config.worktreesDir,
          taskName: input.taskName,
          branchPrefix: input.branchPrefix,
        }),
      ).pipe(Effect.mapError((cause) => taskError(input.projectCwd, String(cause))));
      const created = yield* gitWorkflow.createWorktree({
        cwd: input.projectCwd,
        refName: baseRef,
        newRefName: task.branch,
        baseRefName: input.targetRef,
        path: task.worktreePath,
      });
      // A new task gets its dependencies cloned from a checkout with the same lockfiles.
      const cloned = yield* withTaskServices(
        cloneDependencies({ projectCwd: input.projectCwd, worktreePath: created.worktree.path }),
      ).pipe(
        Effect.tap((names) =>
          names.length > 0
            ? Effect.logInfo("cloned task dependencies", {
                worktreePath: created.worktree.path,
                cloned: names,
              })
            : Effect.void,
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      return {
        branch: created.worktree.refName,
        worktreePath: created.worktree.path,
        dependenciesReady: cloned.length > 0,
      };
    }).pipe(Effect.provideContext(context));

  /**
   * Starts a new task's setup script without waiting for it; success records its lockfiles, so
   * the first merge does not reinstall for nothing.
   */
  const runTaskSetup = (input: {
    readonly threadId: ThreadId;
    readonly projectCwd: string;
    readonly worktreePath: string;
    readonly dependenciesReady?: boolean;
  }) =>
    setupScripts
      .runForThread({
        threadId: input.threadId,
        projectCwd: input.projectCwd,
        worktreePath: input.worktreePath,
        observeCompletion: {},
        ...(input.dependenciesReady ? { extraEnv: DEPENDENCIES_READY_ENV } : {}),
      })
      .pipe(
        Effect.flatMap((result) =>
          result.status === "started" && result.completion
            ? result.completion.pipe(
                Effect.flatMap(({ exitCode }) =>
                  exitCode === 0
                    ? withTaskServices(recordWorktreeDependencies(input.worktreePath)).pipe(
                        Effect.ignoreCause({ log: true }),
                      )
                    : Effect.void,
                ),
                Effect.forkDetach,
                Effect.asVoid,
              )
            : Effect.void,
        ),
        Effect.ignoreCause({ log: true }),
      );

  /** Server-side thread commands (task folders), recorded as the person's or the agent's. */
  const dispatch = (command: OrchestrationV2Command, creationSource: "web" | "mcp") =>
    threadManagement.dispatch(
      ThreadManagementService.withCreationProvenance(command, {
        createdBy: creationSource === "mcp" ? "agent" : "user",
        creationSource,
      }),
    );

  /**
   * Moves a thread to a new task: closes the one it worked in (when its folder is still there)
   * and gives it a new branch and folder from the latest integration branch.
   */
  const continueTask = (
    input: {
      readonly threadId: ThreadId;
      readonly projectCwd: string;
      readonly previous: { readonly worktreePath: string; readonly branch: string } | null;
      readonly targetRef: string;
      readonly taskName: string;
      readonly branchPrefix?: string | undefined;
    },
    creationSource: "web" | "mcp",
  ) =>
    Effect.gen(function* () {
      const fail = (detail: string) =>
        new GitCommandError({
          operation: "GitWorkflowService.continueTask",
          command: "continue task",
          cwd: input.projectCwd,
          detail,
        });
      const previous = input.previous;
      if (previous) {
        const fs = yield* FileSystem.FileSystem;
        if (yield* fs.exists(previous.worktreePath).pipe(Effect.orElseSucceed(() => false))) {
          const closed = yield* gitWorkflow.closeTask({
            projectCwd: input.projectCwd,
            worktreePath: previous.worktreePath,
            branch: previous.branch,
            targetRef: input.targetRef,
            deleteRemote: true,
          });
          if (!closed.removedWorktree) {
            return yield* fail("La carpeta de la tarea tiene cambios sin guardar o está en uso.");
          }
        }
      }
      const { branch, worktreePath, dependenciesReady } = yield* prepareTaskWorktree({
        projectCwd: input.projectCwd,
        targetRef: input.targetRef,
        taskName: input.taskName,
        branchPrefix: input.branchPrefix,
      });
      yield* dispatch(
        {
          type: "thread.metadata.update",
          commandId: yield* commandId("continue-task-meta"),
          threadId: input.threadId,
          branch,
          worktreePath,
        },
        creationSource,
      ).pipe(Effect.mapError((error) => fail(error.message)));
      // Installs and the like run in the thread's terminal; the agent can start meanwhile.
      yield* runTaskSetup({
        threadId: input.threadId,
        projectCwd: input.projectCwd,
        worktreePath,
        dependenciesReady,
      });
      yield* refreshGitStatus(input.projectCwd);
      return { branch, worktreePath };
    }).pipe(Effect.provideContext(context));

  /**
   * Finishes a thread's task once its branch is in `origin/<integration branch>`: a permanent
   * thread continues in its next version, any other task's folder and branch are closed (the
   * thread keeps its conversation, and its next turn starts a fresh folder from the integration
   * branch). Fails when the branch is not merged yet.
   */
  const finishThreadTask = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* threadManagement.getThreadShell(threadId);
      const fail = (detail: string) =>
        new GitCommandError({
          operation: "GitWorkflowService.finishTask",
          command: "finish task",
          cwd: thread?.worktreePath ?? "",
          detail,
        });
      if (!thread) return yield* fail("No encuentro ese hilo.");
      if (!thread.branch || !thread.worktreePath) {
        return yield* fail("Ese hilo no trabaja en una tarea con carpeta propia.");
      }
      const project = Option.getOrNull(yield* projectService.getById(thread.projectId));
      if (!project) return yield* fail("No encuentro el proyecto del hilo.");
      const projectCwd = project.workspaceRoot;
      const targetRef = yield* integrationRef(projectCwd, thread.projectId);
      yield* gitWorkflow.fetchRemote({ cwd: projectCwd, remoteName: "origin", refName: targetRef });
      const merged = yield* git(projectCwd, [
        "merge-base",
        "--is-ancestor",
        thread.branch,
        `origin/${targetRef}`,
      ]).pipe(
        Effect.map((output) => output.code === 0),
        Effect.orElseSucceed(() => false),
      );
      if (!merged) {
        return yield* fail(`${thread.branch} todavía no está en ${targetRef}; fusiónala primero.`);
      }
      const next = nextPermanentTaskName(thread.branch);
      if (next) {
        // The owner's prefix stays: pablo/fabulas-v1 goes on as pablo/fabulas-v2.
        const slash = thread.branch.lastIndexOf("/");
        const continued = yield* continueTask(
          {
            threadId,
            projectCwd,
            previous: { worktreePath: thread.worktreePath, branch: thread.branch },
            targetRef,
            taskName: next,
            ...(slash > 0 ? { branchPrefix: thread.branch.slice(0, slash) } : {}),
          },
          "mcp",
        );
        return { outcome: "continued" as const, targetRef, ...continued };
      }
      const closed = yield* gitWorkflow.closeTask({
        projectCwd,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        targetRef,
        deleteRemote: true,
      });
      yield* refreshGitStatus(projectCwd);
      return {
        outcome: "closed" as const,
        targetRef,
        branch: thread.branch,
        removedWorktree: closed.removedWorktree,
      };
    }).pipe(Effect.provideContext(context));

  return {
    integrationRef,
    prepareTaskWorktree,
    runTaskSetup,
    continueTask,
    finishThreadTask,
    refreshGitStatus,
  };
});
