/**
 * Moves a project to another folder holding the same repository, for example after the
 * checkout is moved out of a synced folder. Threads follow because they resolve their
 * working directory through the project; thread worktrees keep their own paths, and
 * `git worktree repair` points their links back at the moved repository.
 */
import {
  type OrchestrationDispatchCommandError,
  ProjectRelocateError,
  type ProjectRelocateResult,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const fail = (message: string) => new ProjectRelocateError({ message });

const remoteLabel = (identity: RepositoryIdentity | null) =>
  identity ? (identity.displayName ?? identity.canonicalKey) : null;

export const relocateProject = Effect.fn("relocateProject")(function* (input: {
  readonly previousRoot: string;
  /** The identity the project last had; resolved from `previousRoot` when absent. */
  readonly previousIdentity: RepositoryIdentity | null | undefined;
  readonly workspaceRoot: string;
  readonly allowRemoteMismatch: boolean;
  readonly applyWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    processRunner.run({ command: "git", args: ["-C", cwd, ...args] }).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout.trim() : null)),
      Effect.orElseSucceed(() => null),
    );
  const realPath = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => null));

  const target = yield* realPath(input.workspaceRoot);
  if (target === null) return yield* fail(`${input.workspaceRoot} does not exist.`);
  const topLevel = yield* git(target, ["rev-parse", "--show-toplevel"]);
  if (topLevel === null) return yield* fail("That folder is not a Git repository.");
  const repositoryRoot = yield* realPath(topLevel);
  if (repositoryRoot !== target) {
    return yield* fail(`Choose the repository's top folder: ${topLevel}`);
  }
  if ((yield* realPath(input.previousRoot)) === target) {
    return yield* fail("The project already uses that folder.");
  }

  if (!input.allowRemoteMismatch) {
    const previousIdentity =
      input.previousIdentity ??
      ((yield* fs.exists(input.previousRoot).pipe(Effect.orElseSucceed(() => false)))
        ? yield* resolver.resolve(input.previousRoot, { refresh: true })
        : null);
    const nextIdentity = yield* resolver.resolve(target, { refresh: true });
    if (previousIdentity !== null && previousIdentity.canonicalKey !== nextIdentity?.canonicalKey) {
      return {
        _tag: "remote-mismatch",
        previousRemote: remoteLabel(previousIdentity),
        newRemote: remoteLabel(nextIdentity),
      } satisfies ProjectRelocateResult;
    }
  }

  yield* input.applyWorkspaceRoot(target);
  // Worktrees record the repository's absolute path; repair rewrites those links for the new
  // location and prune drops entries whose folders are gone.
  yield* git(target, ["worktree", "repair"]);
  yield* git(target, ["worktree", "prune"]);
  return { _tag: "relocated", workspaceRoot: target } satisfies ProjectRelocateResult;
});
