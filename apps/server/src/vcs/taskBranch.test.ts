import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { resolveTaskWorktree, slugifyTaskName } from "./taskBranch.ts";

const TestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return (yield* runner.run({ command: "git", args: ["-C", cwd, ...args] })).stdout.trim();
  });

it("slugifies task names for branches and folders", () => {
  assert.equal(slugifyTaskName("Arreglar el sidebar!"), "arreglar-el-sidebar");
  assert.equal(slugifyTaskName("Añadir búsqueda  rápida"), "anadir-busqueda-rapida");
  assert.equal(slugifyTaskName("   "), "tarea");
  assert.equal(slugifyTaskName("x".repeat(60)).length, 40);
});

it.layer(TestLayer)("resolveTaskWorktree", (it) => {
  it.effect("names the branch after the git user and skips names already taken", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "task-branch-" });
        const project = path.join(base, "necora-app");
        yield* fs.makeDirectory(project);
        yield* git(project, "init", "-q");
        yield* git(project, "config", "user.name", "Pablo De Rosacruz");
        yield* git(project, "config", "user.email", "p@test.com");
        yield* git(project, "commit", "-q", "--allow-empty", "-m", "init");
        const worktreesDir = path.join(base, "worktrees");

        const first = yield* resolveTaskWorktree({
          projectCwd: project,
          worktreesDir,
          taskName: "Arreglar sidebar",
        });
        assert.deepStrictEqual(first, {
          branch: "pablo/arreglar-sidebar",
          worktreePath: path.join(worktreesDir, "necora-app", "arreglar-sidebar"),
        });

        yield* git(project, "branch", "pablo/arreglar-sidebar");
        const second = yield* resolveTaskWorktree({
          projectCwd: project,
          worktreesDir,
          taskName: "Arreglar sidebar",
        });
        assert.equal(second.branch, "pablo/arreglar-sidebar-2");

        const roi = yield* resolveTaskWorktree({
          projectCwd: project,
          worktreesDir,
          taskName: "Arreglar sidebar",
          branchPrefix: "Roi",
        });
        assert.equal(roi.branch, "roi/arreglar-sidebar");
      }),
    ),
  );
});
