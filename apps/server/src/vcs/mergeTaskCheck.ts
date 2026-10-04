/**
 * Runs a project's pre-merge check in a task's folder and streams its output, so the merge
 * dialog can show the log live and decide on the exit code. The command comes from the
 * repository's own t3.json (`preMergeCheck` or a `runBeforeMerge` script), never from the client.
 * When the task's lockfiles changed since its setup script last succeeded, `setup` runs first
 * in the same log, and a failed setup ends the stream without running the check.
 */
import {
  GitCommandError,
  resolvePreMergeCheck,
  type VcsMergeTaskCheckEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import {
  runWorktreeSetup,
  type TaskWorktree,
  type WorktreeSetupScript,
} from "../project/worktreeDependencies.ts";
import * as ProcessRunner from "../processRunner.ts";

const fail = (cwd: string, detail: string) =>
  new GitCommandError({
    operation: "MergeTaskCheck.run",
    command: "pre-merge check",
    cwd,
    detail,
  });

export const runMergeTaskCheck = (
  cwd: string,
  setup?: { readonly worktree: TaskWorktree; readonly script: WorktreeSetupScript },
) =>
  setup
    ? Stream.fromIterable<VcsMergeTaskCheckEvent>([
        { _tag: "started", command: setup.script.command, setup: true },
      ]).pipe(
        Stream.concat(
          runWorktreeSetup(setup.worktree, setup.script).pipe(
            Stream.provide(ProcessRunner.layer),
            Stream.flatMap((event) =>
              event._tag === "output"
                ? Stream.fromIterable<VcsMergeTaskCheckEvent>([
                    { _tag: "output", text: event.text },
                  ])
                : event.exitCode === 0
                  ? runCheck(cwd)
                  : Stream.fromIterable<VcsMergeTaskCheckEvent>([
                      { _tag: "finished", exitCode: event.exitCode, setupFailed: true },
                    ]),
            ),
          ),
        ),
      )
    : runCheck(cwd);

const runCheck = (cwd: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
      const command = resolvePreMergeCheck(Option.getOrNull(yield* loader.load(cwd)));
      if (command === null) {
        const noCheck: ReadonlyArray<VcsMergeTaskCheckEvent> = [
          { _tag: "started", command: null },
          { _tag: "finished", exitCode: 0 },
        ];
        return Stream.fromIterable(noCheck);
      }
      const path = yield* Path.Path;
      const processRunner = yield* ProcessRunner.ProcessRunner;
      // Setup scripts find the main checkout the same way.
      const commonDir = yield* processRunner
        .run({
          command: "git",
          args: ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        })
        .pipe(
          Effect.map((output) => output.stdout.trim()),
          Effect.orElseSucceed(() => ""),
        );
      const projectRoot = commonDir ? path.dirname(commonDir) : cwd;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner
        .spawn(
          ChildProcess.make("/bin/sh", ["-lc", command], {
            cwd,
            env: { T3CODE_PROJECT_ROOT: projectRoot, CI: "1" },
            extendEnv: true,
          }),
        )
        .pipe(Effect.mapError((cause) => fail(cwd, `Could not start the check: ${cause.message}`)));
      const output = Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.map((text): VcsMergeTaskCheckEvent => ({ _tag: "output", text })),
        Stream.mapError((cause) =>
          fail(cwd, `The check's output could not be read: ${String(cause)}`),
        ),
      );
      const finished = Stream.fromEffect(
        child.exitCode.pipe(
          Effect.map((code): VcsMergeTaskCheckEvent => ({
            _tag: "finished",
            exitCode: Number(code),
          })),
          Effect.mapError((cause) => fail(cwd, `The check did not finish: ${String(cause)}`)),
        ),
      );
      const started: VcsMergeTaskCheckEvent = { _tag: "started", command };
      return Stream.make(started).pipe(Stream.concat(output), Stream.concat(finished));
    }).pipe(Effect.provide(Layer.mergeAll(T3ProjectFileLoader.layer, ProcessRunner.layer))),
  );
