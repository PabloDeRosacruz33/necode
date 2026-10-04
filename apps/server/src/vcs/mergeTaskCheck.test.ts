import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { runMergeTaskCheck } from "./mergeTaskCheck.ts";

/** `file` is the t3.json text, written as-is. */
const withProjectFile = (file: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "merge-check-" });
    if (file) yield* fs.writeFileString(path.join(cwd, "t3.json"), file);
    return cwd;
  });

const collect = (cwd: string, setupCommand?: string) =>
  runMergeTaskCheck(
    cwd,
    setupCommand === undefined
      ? undefined
      : {
          worktree: { root: cwd, projectRoot: cwd, gitDir: cwd },
          script: { name: "Preparar worktree", command: setupCommand },
        },
  ).pipe(
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
  );

it.layer(NodeServices.layer)("runMergeTaskCheck", (it) => {
  it.effect("streams the project's check and reports its exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProjectFile('{"preMergeCheck": "echo checking; exit 3"}');

        const events = yield* collect(cwd);

        assert.deepStrictEqual(events[0], { _tag: "started", command: "echo checking; exit 3" });
        const output = events.flatMap((event) => (event._tag === "output" ? [event.text] : []));
        assert.include(output.join(""), "checking");
        assert.deepStrictEqual(events.at(-1), { _tag: "finished", exitCode: 3 });
      }),
    ),
  );

  it.effect("uses the script marked runBeforeMerge when there is no preMergeCheck", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProjectFile(
          '{"scripts": [{"name": "Dev", "command": "exit 1"}, {"name": "Comprobar", "command": "true", "runBeforeMerge": true}]}',
        );

        const events = yield* collect(cwd);

        assert.deepStrictEqual(events[0], { _tag: "started", command: "true" });
        assert.deepStrictEqual(events.at(-1), { _tag: "finished", exitCode: 0 });
      }),
    ),
  );

  it.effect("passes straight through when the project declares no check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProjectFile(null);

        assert.deepStrictEqual(yield* collect(cwd), [
          { _tag: "started", command: null },
          { _tag: "finished", exitCode: 0 },
        ]);
      }),
    ),
  );

  it.effect("reinstalls first when the task's dependencies are stale, then checks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProjectFile('{"preMergeCheck": "echo checking"}');

        const events = yield* collect(cwd, "echo installing");

        assert.deepStrictEqual(events[0], {
          _tag: "started",
          command: "echo installing",
          setup: true,
        });
        const checkStart = events.findIndex(
          (event) => event._tag === "started" && event.command === "echo checking",
        );
        assert.isAbove(checkStart, 0);
        const output = events.flatMap((event) => (event._tag === "output" ? [event.text] : []));
        assert.include(output.join(""), "installing");
        assert.include(output.join(""), "checking");
        assert.deepStrictEqual(events.at(-1), { _tag: "finished", exitCode: 0 });
      }),
    ),
  );

  it.effect("stops without running the check when the reinstall fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProjectFile('{"preMergeCheck": "echo checking"}');

        const events = yield* collect(cwd, "exit 5");

        assert.isFalse(
          events.some((event) => event._tag === "started" && event.command === "echo checking"),
        );
        assert.deepStrictEqual(events.at(-1), { _tag: "finished", exitCode: 5, setupFailed: true });
      }),
    ),
  );
});
