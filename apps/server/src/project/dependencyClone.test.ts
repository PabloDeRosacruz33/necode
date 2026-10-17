import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { cloneDependencies } from "./dependencyClone.ts";

const TestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** A repository with a checked-in lockfile and a linked task worktree. */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "dependency-clone-" });
  const project = path.join(base, "project");
  yield* fs.makeDirectory(project);
  const git = (args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: ["-C", project, ...args] });
  yield* git(["init", "-q", "-b", "main"]);
  yield* git(["config", "user.email", "t@example.com"]);
  yield* git(["config", "user.name", "T"]);
  yield* fs.writeFileString(path.join(project, "package-lock.json"), "{ lock: 1 }");
  yield* fs.writeFileString(path.join(project, ".gitignore"), "node_modules\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-q", "-m", "init"]);
  const task = path.join(base, "task");
  yield* git(["worktree", "add", "-q", "-b", "task", task, "main"]);
  return { project, task, git };
});

it.layer(TestLayer)("cloneDependencies", (it) => {
  it.effect("copies node_modules from the checkout whose lockfile matches, and tells no lies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { project, task } = yield* repository;
        yield* fs.makeDirectory(path.join(project, "node_modules", "left-pad"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(project, "node_modules", "left-pad", "index.js"), "1");
        const cloned = yield* cloneDependencies({ projectCwd: project, worktreePath: task }).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
        );
        assert.deepStrictEqual(cloned, ["."]);
        assert.equal(
          yield* fs.readFileString(path.join(task, "node_modules", "left-pad", "index.js")),
          "1",
        );
      }),
    ),
  );

  it.effect("installs nothing when the lockfiles differ or elsewhere than a Mac", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { project, task } = yield* repository;
        yield* fs.makeDirectory(path.join(project, "node_modules"), { recursive: true });
        yield* fs.writeFileString(path.join(task, "package-lock.json"), "{ lock: 2 }");
        const differing = yield* cloneDependencies({
          projectCwd: project,
          worktreePath: task,
        }).pipe(Effect.provideService(HostProcess.Platform, "darwin"));
        assert.deepStrictEqual(differing, []);
        assert.isFalse(yield* fs.exists(path.join(task, "node_modules")));
        yield* fs.writeFileString(path.join(task, "package-lock.json"), "{ lock: 1 }");
        const linux = yield* cloneDependencies({ projectCwd: project, worktreePath: task }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        assert.deepStrictEqual(linux, []);
      }),
    ),
  );
});
