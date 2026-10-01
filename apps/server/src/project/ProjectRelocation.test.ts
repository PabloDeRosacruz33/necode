import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { relocateProject } from "./ProjectRelocation.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const TestLayer = Layer.mergeAll(RepositoryIdentityResolver.layer, ProcessRunner.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const output = yield* runner.run({ command: "git", args: ["-C", cwd, ...args] });
    return output.stdout.trim();
  });

const makeRepo = (remote: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "relocate-" });
    yield* git(cwd, "init", "-q");
    yield* git(cwd, "config", "user.email", "test@test.com");
    yield* git(cwd, "config", "user.name", "Test");
    yield* git(cwd, "remote", "add", "origin", remote);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "# repo\n");
    yield* git(cwd, "add", ".");
    yield* git(cwd, "commit", "-q", "-m", "init");
    return yield* fs.realPath(cwd);
  });

const relocate = (input: {
  previousRoot: string;
  workspaceRoot: string;
  allowRemoteMismatch?: boolean;
}) => {
  const applied: string[] = [];
  return relocateProject({
    previousRoot: input.previousRoot,
    previousIdentity: undefined,
    workspaceRoot: input.workspaceRoot,
    allowRemoteMismatch: input.allowRemoteMismatch ?? false,
    applyWorkspaceRoot: (root) => Effect.sync(() => void applied.push(root)),
  }).pipe(Effect.map((result) => ({ result, applied })));
};

it.layer(TestLayer)("relocateProject", (it) => {
  it.effect("moves the project to a copy of the same repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previous = yield* makeRepo("git@github.com:necora/necora-app.git");
        const next = yield* makeRepo("https://github.com/necora/necora-app.git");

        const { result, applied } = yield* relocate({
          previousRoot: previous,
          workspaceRoot: next,
        });

        assert.deepStrictEqual(result, { _tag: "relocated", workspaceRoot: next });
        assert.deepStrictEqual(applied, [next]);
      }),
    ),
  );

  it.effect("asks before moving to a different repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previous = yield* makeRepo("git@github.com:necora/necora-app.git");
        const next = yield* makeRepo("git@github.com:necora/other.git");

        const first = yield* relocate({ previousRoot: previous, workspaceRoot: next });
        assert.deepStrictEqual(first.result, {
          _tag: "remote-mismatch",
          previousRemote: "necora/necora-app",
          newRemote: "necora/other",
        });
        assert.deepStrictEqual(first.applied, []);

        const confirmed = yield* relocate({
          previousRoot: previous,
          workspaceRoot: next,
          allowRemoteMismatch: true,
        });
        assert.equal(confirmed.result._tag, "relocated");
      }),
    ),
  );

  it.effect("moves without asking when the old folder is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const next = yield* makeRepo("git@github.com:necora/necora-app.git");

        const { result } = yield* relocate({
          previousRoot: "/nonexistent/Necora App",
          workspaceRoot: next,
        });

        assert.equal(result._tag, "relocated");
      }),
    ),
  );

  it.effect("rejects a folder that is not a repository root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = yield* makeRepo("git@github.com:necora/necora-app.git");
        const nested = path.join(repo, "apps");
        yield* fs.makeDirectory(nested);
        const plain = yield* fs.makeTempDirectoryScoped({ prefix: "plain-" });

        const nestedError = yield* relocate({ previousRoot: repo, workspaceRoot: nested }).pipe(
          Effect.flip,
        );
        assert.include(nestedError.message, "top folder");
        const plainError = yield* relocate({ previousRoot: repo, workspaceRoot: plain }).pipe(
          Effect.flip,
        );
        assert.include(plainError.message, "not a Git repository");
      }),
    ),
  );

  it.effect("repairs worktrees that pointed at the old location", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "move-" });
        const original = path.join(base, "Necora App");
        yield* fs.makeDirectory(original);
        yield* git(original, "init", "-q");
        yield* git(original, "config", "user.email", "test@test.com");
        yield* git(original, "config", "user.name", "Test");
        yield* git(original, "remote", "add", "origin", "git@github.com:necora/necora-app.git");
        yield* fs.writeFileString(path.join(original, "README.md"), "# repo\n");
        yield* git(original, "add", ".");
        yield* git(original, "commit", "-q", "-m", "init");
        const worktree = path.join(base, "task");
        yield* git(original, "worktree", "add", "-q", "-b", "pablo/task", worktree);
        const moved = path.join(base, "necora-app");
        yield* fs.rename(original, moved);

        const { result } = yield* relocate({ previousRoot: original, workspaceRoot: moved });

        assert.equal(result._tag, "relocated");
        assert.equal(yield* git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "pablo/task");
        assert.include(yield* git(moved, "worktree", "list"), "pablo/task");
      }),
    ),
  );
});
