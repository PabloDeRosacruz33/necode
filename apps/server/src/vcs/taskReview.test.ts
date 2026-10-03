import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  formatTaskMergeMessage,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { parseIncomingLog, readTaskReview } from "./taskReview.ts";

const TestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const output = yield* runner.run({ command: "git", args: ["-C", cwd, ...args] });
    if (output.code !== 0) return yield* Effect.die(`git ${args.join(" ")}: ${output.stderr}`);
    return output.stdout.trim();
  });

const textGeneration = (
  generatePrContent: TextGeneration["Service"]["generatePrContent"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: () => Effect.die("not used"),
    generatePrContent,
    generateBranchName: () => Effect.die("not used"),
    generateThreadTitle: () => Effect.die("not used"),
  });

const commitFile = (
  cwd: string,
  file: string,
  content: string,
  message: string,
  author = "Pablo",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(cwd, file), content);
    yield* git(cwd, "add", file);
    yield* git(cwd, "-c", `user.name=${author}`, "commit", "-q", "-m", message);
  });

/**
 * Roi's task starts from staging and speeds up the chat list. Meanwhile Pablo merges a task
 * that adds account settings and also touches the chat list, and someone pushes a direct fix.
 * Roi's task then brings staging in, as "Fusionar en staging" does before the review.
 */
const makeTaskWithIncomingWork = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "task-review-" });
  const origin = path.join(base, "origin.git");
  const project = path.join(base, "project");
  const task = path.join(base, "task");
  yield* fs.makeDirectory(origin);
  yield* git(origin, "init", "-q", "--bare", "-b", "staging");
  yield* git(base, "clone", "-q", origin, project);
  yield* git(project, "config", "user.name", "Pablo");
  yield* git(project, "config", "user.email", "pablo@test.com");
  yield* git(project, "checkout", "-q", "-b", "staging");
  yield* commitFile(project, "chat.ts", "list v1\n", "init");
  yield* git(project, "push", "-q", "origin", "staging");

  yield* git(project, "worktree", "add", "-q", "-b", "roi/perf", task, "origin/staging");
  yield* commitFile(task, "chat.ts", "list v1 fast\n", "perf: faster chat list", "Roi");

  yield* git(project, "checkout", "-q", "-b", "pablo/ajustes");
  yield* commitFile(project, "settings.ts", "account\n", "feat: account settings");
  yield* commitFile(project, "chat.ts", "list v2\n", "feat: new chat list design");
  yield* git(project, "checkout", "-q", "staging");
  yield* git(
    project,
    "merge",
    "-q",
    "--no-ff",
    "pablo/ajustes",
    "-m",
    formatTaskMergeMessage({
      branch: "pablo/ajustes",
      targetRef: "staging",
      title: "Ajustes de la cuenta",
      summary: ["Nueva pantalla de ajustes de la cuenta", "Nuevo diseño de la lista de chats"],
      howToTest: ["Abre Ajustes → Cuenta y cambia tu nombre"],
      testedWith: [],
    }),
  );
  yield* commitFile(project, "README.md", "hola\n", "fix: typo");
  yield* git(project, "push", "-q", "origin", "staging");

  yield* git(task, "fetch", "-q", "origin");
  yield* git(task, "merge", "-q", "--no-edit", "-X", "ours", "origin/staging");
  return task;
});

it("reads the summary each task merge recorded and leaves out the task's own merges", () => {
  const record = (subject: string, body: string) =>
    `abc${subject.length}\x1fPablo\x1f2026-10-03T10:00:00Z\x1f${subject}\x1f${body}\x1e`;
  const entries = parseIncomingLog(
    [
      record(
        "merge: pablo/ajustes into staging",
        "Ajustes\n\n## Resumen\n- Nueva pantalla\n\n## Cómo probarlo\n- Abre Ajustes",
      ),
      record("merge: roi/perf into staging", "Antes"),
      record("fix: typo", ""),
    ].join("\n"),
    "roi/perf",
  );

  assert.deepStrictEqual(
    entries.map(({ title, summary, howToTest }) => ({ title, summary, howToTest })),
    [
      { title: "Ajustes", summary: ["Nueva pantalla"], howToTest: ["Abre Ajustes"] },
      { title: "fix: typo", summary: [], howToTest: [] },
    ],
  );
});

it.layer(TestLayer)("readTaskReview", (it) => {
  it.effect("lists what others merged since the task started next to the task's summary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const task = yield* makeTaskWithIncomingWork;

        const review = yield* readTaskReview({
          cwd: task,
          targetRef: "staging",
          modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        }).pipe(
          Effect.provideService(
            TextGeneration,
            textGeneration(() =>
              Effect.succeed({
                title: "La lista de chats va más rápida",
                body: "## Resumen\n- La lista va rápida con muchos mensajes\n\n## Cómo probarlo\n- Abre un chat con muchos mensajes",
              }),
            ),
          ),
        );

        assert.deepStrictEqual(
          review.incoming.map(({ author, title, summary, howToTest }) => ({
            author,
            title,
            summary,
            howToTest,
          })),
          [
            { author: "Pablo", title: "fix: typo", summary: [], howToTest: [] },
            {
              author: "Pablo",
              title: "Ajustes de la cuenta",
              summary: [
                "Nueva pantalla de ajustes de la cuenta",
                "Nuevo diseño de la lista de chats",
              ],
              howToTest: ["Abre Ajustes → Cuenta y cambia tu nombre"],
            },
          ],
        );
        assert.deepStrictEqual(review.own, {
          title: "La lista de chats va más rápida",
          summary: ["La lista va rápida con muchos mensajes"],
          howToTest: ["Abre un chat con muchos mensajes"],
          generated: true,
        });
        assert.deepStrictEqual(review.sharedFiles, ["chat.ts"]);
      }),
    ),
  );

  it.effect("falls back to the task's commits when the summary cannot be written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const task = yield* makeTaskWithIncomingWork;

        const review = yield* readTaskReview({
          cwd: task,
          targetRef: "staging",
          modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        }).pipe(
          Effect.provideService(
            TextGeneration,
            textGeneration(() =>
              Effect.fail(new TextGenerationError({ operation: "generatePrContent", detail: "x" })),
            ),
          ),
        );

        assert.deepStrictEqual(review.own, {
          title: "perf: faster chat list",
          summary: ["perf: faster chat list"],
          howToTest: [],
          generated: false,
        });
        assert.equal(review.incoming.length, 2);
      }),
    ),
  );
});
