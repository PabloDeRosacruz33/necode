/**
 * Keeps a task worktree's installed dependencies in step with its lockfiles. Each time the
 * project's setup script (the one marked `runOnWorktreeCreate`) succeeds in a worktree, the
 * lockfiles' fingerprint is written to that worktree's own git directory, out of the working
 * tree and gone with the worktree. Bringing in work that changes a lockfile makes the
 * fingerprints differ, so the setup runs again before the task is used or merged. A worktree
 * with no record yet counts as stale: ones created before this existed reinstall once.
 */
import type { VcsWorktreeSetupRun } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const RECORD_FILE = "necode-setup-lockfiles";
const OUTPUT_TAIL_LENGTH = 4_000;

export interface WorktreeSetupScript {
  readonly name: string;
  readonly command: string;
}

export interface TaskWorktree {
  /** The worktree's top-level folder. */
  readonly root: string;
  /** The main checkout, where the project lives. */
  readonly projectRoot: string;
  readonly gitDir: string;
}

/** The task worktree `cwd` belongs to, or null for a main checkout or a folder outside git. */
export const locateTaskWorktree = Effect.fn("locateTaskWorktree")(function* (cwd: string) {
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const output = yield* processRunner
    .run({
      command: "git",
      args: [
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
      ],
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (!output || output.code !== 0) return null;
  const [root, gitDir, commonDir] = output.stdout.trim().split("\n");
  if (!root || !gitDir || !commonDir) return null;
  if (path.resolve(gitDir) === path.resolve(commonDir)) return null;
  return { root, projectRoot: path.dirname(commonDir), gitDir } satisfies TaskWorktree;
});

/** Null when the worktree has no lockfile, so there is nothing to keep in step. */
const fingerprintLockfiles = Effect.fn("fingerprintLockfiles")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hash = NodeCrypto.createHash("sha256");
  let found = false;
  for (const name of LOCKFILES) {
    const content = yield* fs
      .readFile(path.join(root, name))
      .pipe(Effect.orElseSucceed(() => null));
    if (content === null) continue;
    found = true;
    hash.update(`${name}\0`).update(content).update("\0");
  }
  return found ? hash.digest("hex") : null;
});

/** Whether the setup script must run again in this task worktree before it is used. */
export const worktreeDependenciesStale = Effect.fn("worktreeDependenciesStale")(function* (
  worktree: TaskWorktree,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* fingerprintLockfiles(worktree.root);
  if (current === null) return false;
  const recorded = yield* fs
    .readFileString(path.join(worktree.gitDir, RECORD_FILE))
    .pipe(Effect.orElseSucceed(() => ""));
  return recorded.trim() !== current;
});

/** Called after the setup script succeeds in `cwd`; a no-op outside a task worktree. */
export const recordWorktreeDependencies = Effect.fn("recordWorktreeDependencies")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktree = yield* locateTaskWorktree(cwd);
  if (!worktree) return;
  const current = yield* fingerprintLockfiles(worktree.root);
  if (current === null) return;
  yield* fs
    .writeFileString(path.join(worktree.gitDir, RECORD_FILE), `${current}\n`)
    .pipe(Effect.ignore({ log: true }));
});

export type WorktreeSetupEvent =
  | { readonly _tag: "output"; readonly text: string }
  | { readonly _tag: "exit"; readonly exitCode: number | null };

/**
 * Runs the setup script in the worktree with the same environment as when Necode created it,
 * streaming its output and ending with its exit code. Success records the lockfiles.
 */
export const runWorktreeSetup = (worktree: TaskWorktree, script: WorktreeSetupScript) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
      >();
      const child = yield* spawner.spawn(
        ChildProcess.make("/bin/sh", ["-lc", script.command], {
          cwd: worktree.root,
          env: {
            T3CODE_PROJECT_ROOT: worktree.projectRoot,
            T3CODE_WORKTREE_PATH: worktree.root,
            CI: "1",
          },
          extendEnv: true,
        }),
      );
      const output = Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.map((text): WorktreeSetupEvent => ({ _tag: "output", text })),
      );
      const exit = Stream.fromEffect(
        child.exitCode.pipe(
          Effect.map(Number),
          Effect.tap((exitCode) =>
            exitCode === 0
              ? recordWorktreeDependencies(worktree.root).pipe(Effect.provide(services))
              : Effect.void,
          ),
          Effect.map((exitCode): WorktreeSetupEvent => ({ _tag: "exit", exitCode })),
        ),
      );
      return output.pipe(Stream.concat(exit));
    }),
  ).pipe(
    // A script that cannot start or be read is a failed setup, not a broken stream.
    Stream.catch((cause) =>
      Stream.fromIterable<WorktreeSetupEvent>([
        { _tag: "output", text: `\n${String(cause)}\n` },
        { _tag: "exit", exitCode: null },
      ]),
    ),
  );

/**
 * Reruns the setup script when the task worktree's lockfiles changed since it last succeeded.
 * Returns what ran, or undefined when nothing had to (not a task, no setup script, or current).
 */
export const refreshWorktreeDependencies = Effect.fn("refreshWorktreeDependencies")(function* (
  cwd: string,
  resolveScript: (worktree: TaskWorktree) => Effect.Effect<WorktreeSetupScript | null>,
) {
  const worktree = yield* locateTaskWorktree(cwd);
  if (!worktree || !(yield* worktreeDependenciesStale(worktree))) return undefined;
  const script = yield* resolveScript(worktree);
  if (!script) return undefined;
  let output = "";
  let exitCode: number | null = null;
  yield* runWorktreeSetup(worktree, script).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event._tag === "output") output = (output + event.text).slice(-OUTPUT_TAIL_LENGTH);
        else exitCode = event.exitCode;
      }),
    ),
  );
  return {
    name: script.name,
    command: script.command,
    exitCode,
    output,
  } satisfies VcsWorktreeSetupRun;
});
