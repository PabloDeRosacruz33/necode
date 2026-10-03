import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { locateTaskWorktree, refreshWorktreeDependencies } from "./worktreeDependencies.ts";

const TestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return (yield* runner.run({ command: "git", args: ["-C", cwd, ...args] })).stdout.trim();
  });

/** A project with a lockfile and one task worktree on its own branch. */
const makeProjectWithTask = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "worktree-deps-" });
  const project = path.join(base, "project");
  const worktree = path.join(base, "task");
  yield* fs.makeDirectory(project);
  yield* git(project, "init", "-q");
  yield* git(project, "config", "user.name", "Roi");
  yield* git(project, "config", "user.email", "roi@test.com");
  yield* fs.writeFileString(path.join(project, "package-lock.json"), '{"v": 1}\n');
  yield* git(project, "add", ".");
  yield* git(project, "commit", "-q", "-m", "init");
  yield* git(project, "worktree", "add", "-q", "-b", "roi/task", worktree);
  return { base, project, worktree };
});

const countLines = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    return text.split("\n").filter((line) => line.length > 0).length;
  });

it.layer(TestLayer)("refreshWorktreeDependencies", (it) => {
  it.effect("runs the setup again only when the task's lockfiles changed since it succeeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { base, project, worktree } = yield* makeProjectWithTask;
        const runs = path.join(base, "runs");
        const script = () =>
          Effect.succeed({ name: "Preparar worktree", command: `echo run >> "${runs}"` });

        assert.isNull(yield* locateTaskWorktree(project));
        assert.isUndefined(yield* refreshWorktreeDependencies(project, script));

        // A worktree Necode never recorded counts as stale.
        const first = yield* refreshWorktreeDependencies(worktree, script);
        assert.equal(first?.exitCode, 0);
        assert.isUndefined(yield* refreshWorktreeDependencies(worktree, script));

        yield* fs.writeFileString(path.join(worktree, "package-lock.json"), '{"v": 2}\n');
        const second = yield* refreshWorktreeDependencies(worktree, script);
        assert.equal(second?.exitCode, 0);
        assert.isUndefined(yield* refreshWorktreeDependencies(worktree, script));
        assert.equal(yield* countLines(runs), 2);
      }),
    ),
  );

  it.effect("reports a failed setup and tries again next time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { worktree } = yield* makeProjectWithTask;
        const script = () =>
          Effect.succeed({ name: "Preparar worktree", command: "echo broken; exit 4" });

        const failed = yield* refreshWorktreeDependencies(worktree, script);
        assert.equal(failed?.exitCode, 4);
        assert.include(failed?.output ?? "", "broken");
        assert.equal((yield* refreshWorktreeDependencies(worktree, script))?.exitCode, 4);
      }),
    ),
  );

  it.effect("does nothing when the project has no setup script", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { worktree } = yield* makeProjectWithTask;
        assert.isUndefined(
          yield* refreshWorktreeDependencies(worktree, () => Effect.succeed(null)),
        );
      }),
    ),
  );
});
