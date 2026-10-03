/**
 * What a task merge brings together, written for the person merging. `incoming` is the work
 * that reached the integration branch since the task started: one entry per first-parent
 * commit there (another task's merge or a direct commit), with the summary its merge recorded
 * through `formatTaskMergeMessage`. The task's own summary is written in plain Spanish by the
 * source control writer model and goes into this merge's message, so whoever merges next sees
 * it as incoming work. Runs after `mergeTaskPrepare`, when the task already holds the
 * integration branch.
 */
import {
  type ModelSelection,
  parseTaskMergeMessage,
  type VcsMergeTaskReviewEntry,
  type VcsMergeTaskReviewResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const INCOMING_LIMIT = 30;
const OWN_PATCH_LIMIT = 60_000;
const OWN_SUMMARY_LIMIT = 20_000;
const FIELD = "\x1f";
const RECORD = "\x1e";

const SUMMARY_TEMPLATE = [
  "## Resumen",
  "- (Un punto por cada cambio que nota quien usa la app.)",
  "",
  "## Cómo probarlo",
  "- (Un punto por cambio: qué abrir, qué hacer y qué debería verse, para probarlo a mano en la app.)",
].join("\n");

const SUMMARY_INSTRUCTIONS = [
  "Escribe en español sencillo, para alguien que no programa: sin nombres de archivos, funciones ni términos técnicos.",
  "El título es una frase corta que dice qué cambia para quien usa la app.",
  "Como mucho 6 puntos por sección.",
].join("\n");

/** Entries for the commits `git log --first-parent` printed with the review format. */
export function parseIncomingLog(
  output: string,
  branch: string,
): ReadonlyArray<VcsMergeTaskReviewEntry> {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [commit = "", author = "", date = "", subject = "", body = ""] = record.split(FIELD);
      return { commit, author, date, subject, body };
    })
    .filter(
      (entry) => entry.commit.length > 0 && !entry.subject.startsWith(`merge: ${branch} into `),
    )
    .map(({ commit, author, date, subject, body }) => {
      const recorded = parseTaskMergeMessage(body);
      const isTaskMerge = subject.startsWith("merge: ");
      return {
        commit,
        author,
        date,
        title: (isTaskMerge ? recorded.title : null) ?? subject,
        summary: recorded.summary,
        howToTest: recorded.howToTest,
      };
    });
}

export const readTaskReview = Effect.fn("readTaskReview")(function* (input: {
  readonly cwd: string;
  readonly targetRef: string;
  readonly modelSelection: ModelSelection;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const textGeneration = yield* TextGeneration;
  const git = (args: ReadonlyArray<string>) =>
    processRunner
      .run({
        command: "git",
        args: ["-C", input.cwd, ...args],
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );
  const lines = (output: string | null) =>
    (output ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const mergedRef = `origin/${input.targetRef}`;
  const branch = (yield* git(["symbolic-ref", "--short", "HEAD"]))?.trim() ?? "";
  // The oldest entry of the branch's reflog is where the task started.
  const created = lines(yield* git(["reflog", "show", "--format=%H", `refs/heads/${branch}`])).at(
    -1,
  );
  const startedAt =
    created && (yield* git(["merge-base", "--is-ancestor", created, "HEAD"])) !== null
      ? created
      : (yield* git(["merge-base", "--fork-point", mergedRef, "HEAD"]))?.trim() || null;

  const incomingLog = startedAt
    ? yield* git([
        "log",
        "--first-parent",
        `--max-count=${INCOMING_LIMIT + 1}`,
        `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%b${RECORD}`,
        `${startedAt}..${mergedRef}`,
      ])
    : null;
  const incomingAll = parseIncomingLog(incomingLog ?? "", branch);

  const [ownLog, ownStat, ownPatch, ownFiles, incomingFiles] = yield* Effect.all(
    [
      git(["log", "--oneline", "--no-merges", `${mergedRef}..HEAD`]),
      git(["diff", "--stat", mergedRef, "HEAD"]),
      git(["diff", "--no-ext-diff", "--patch", "--minimal", mergedRef, "HEAD"]),
      git(["diff", "--name-only", mergedRef, "HEAD"]),
      startedAt ? git(["diff", "--name-only", startedAt, mergedRef]) : Effect.succeed(null),
    ],
    { concurrency: "unbounded" },
  );
  const ownCommits = lines(ownLog).map((line) => line.replace(/^\S+\s+/, ""));
  const generated = yield* textGeneration
    .generatePrContent({
      cwd: input.cwd,
      baseBranch: input.targetRef,
      headBranch: branch,
      commitSummary: (ownLog ?? "").slice(0, OWN_SUMMARY_LIMIT),
      diffSummary: (ownStat ?? "").slice(0, OWN_SUMMARY_LIMIT),
      diffPatch: (ownPatch ?? "").slice(0, OWN_PATCH_LIMIT),
      changeRequestTemplate: SUMMARY_TEMPLATE,
      policy: {
        kind: "custom",
        changeRequestInstructions: SUMMARY_INSTRUCTIONS,
        inferRepositoryConventions: false,
      },
      modelSelection: input.modelSelection,
    })
    .pipe(
      Effect.map((content) => ({ ...parseTaskMergeMessage(content.body), title: content.title })),
      Effect.tapError((error) => Effect.logWarning("Task summary generation failed", error)),
      Effect.orElseSucceed(() => null),
    );
  const own =
    generated && generated.summary.length > 0
      ? {
          title: generated.title.trim(),
          summary: generated.summary,
          howToTest: generated.howToTest,
          generated: true,
        }
      : { title: ownCommits[0] ?? branch, summary: ownCommits, howToTest: [], generated: false };

  const touchedByIncoming = new Set(lines(incomingFiles));
  return {
    incoming: incomingAll.slice(0, INCOMING_LIMIT),
    incomingTruncated: incomingAll.length > INCOMING_LIMIT,
    own,
    sharedFiles: lines(ownFiles).filter((file) => touchedByIncoming.has(file)),
  } satisfies VcsMergeTaskReviewResult;
});
