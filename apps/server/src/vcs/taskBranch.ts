/**
 * Names for a task started with "Nueva tarea": the branch `<prefix>/<slug>` and its worktree
 * folder `<worktreesDir>/<repo>/<slug>`, both free on this machine and on origin.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const TASK_SLUG_MAX_LENGTH = 40;
const FALLBACK_PREFIX = "tarea";

/** "Arreglar el sidebar!" → "arreglar-el-sidebar". */
export function slugifyTaskName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TASK_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "tarea";
}

export const resolveTaskWorktree = Effect.fn("resolveTaskWorktree")(function* (input: {
  readonly projectCwd: string;
  readonly worktreesDir: string;
  readonly taskName: string;
  readonly branchPrefix?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const git = (args: ReadonlyArray<string>) =>
    processRunner.run({ command: "git", args: ["-C", input.projectCwd, ...args] }).pipe(
      Effect.map((output) => ({ ok: output.code === 0, stdout: output.stdout.trim() })),
      Effect.orElseSucceed(() => ({ ok: false, stdout: "" })),
    );

  const prefixSource =
    input.branchPrefix ?? (yield* git(["config", "user.name"])).stdout.split(/\s+/)[0] ?? "";
  const prefix = prefixSource.trim() ? slugifyTaskName(prefixSource) : FALLBACK_PREFIX;
  const slug = slugifyTaskName(input.taskName);
  const repoDir = path.join(input.worktreesDir, path.basename(input.projectCwd));

  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? slug : `${slug}-${attempt}`;
    const branch = `${prefix}/${name}`;
    const worktreePath = path.join(repoDir, name);
    const taken =
      (yield* git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok ||
      (yield* git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).ok ||
      (yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
    if (!taken) return { branch, worktreePath };
  }
});
