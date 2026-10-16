/**
 * A new task starts with the installed dependencies of a checkout that has the same lockfiles,
 * copied as APFS clones (`cp -c`): instant, and sharing disk blocks until a file changes. Every
 * task installing its own copy was the bulk of the tasks folder. Only `node_modules` beside a
 * matching lockfile is copied, only from a checkout on the same volume, and the setup script is
 * told through T3CODE_DEPENDENCIES_READY=1 so it can skip its install.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { LOCKFILES } from "./worktreeDependencies.ts";

/** Deep enough for monorepos (`apps/mobile`), shallow enough to stay instant. */
const MAX_DEPTH = 3;
const SKIPPED = new Set(["node_modules", ".git", "build", "dist", ".next", "ios", "android"]);

/** The lockfiles of the new task, as paths relative to its root. */
const findLockfiles = Effect.fn("dependencyClone.findLockfiles")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<string> = [];
  let level = [""];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: Array<string> = [];
    for (const dir of level) {
      const entries = yield* fs
        .readDirectory(path.join(root, dir))
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const entry of entries) {
        if ((LOCKFILES as ReadonlyArray<string>).includes(entry)) found.push(path.join(dir, entry));
      }
      for (const entry of entries) {
        if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
        const child = path.join(root, dir, entry);
        const stat = yield* fs.stat(child).pipe(Effect.orElseSucceed(() => null));
        if (stat?.type === "Directory") next.push(path.join(dir, entry));
      }
    }
    level = next;
  }
  return found;
});

/**
 * Clones dependencies into `worktreePath` from the project's checkout or one of its other
 * tasks. Returns the lockfile directories that got them (relative, "." for the root).
 */
export const cloneDependencies = Effect.fn("cloneDependencies")(function* (input: {
  readonly projectCwd: string;
  readonly worktreePath: string;
}) {
  if ((yield* HostProcessPlatform) !== "darwin") return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const lockfiles = yield* findLockfiles(input.worktreePath);
  if (lockfiles.length === 0) return [];

  const listed = yield* runner
    .run({ command: "git", args: ["-C", input.projectCwd, "worktree", "list", "--porcelain"] })
    .pipe(Effect.orElseSucceed(() => null));
  if (!listed || listed.code !== 0) return [];
  const target = path.resolve(input.worktreePath);
  const checkouts = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)))
    .filter((checkout) => checkout !== target);
  // The project checkout first, then the most recently touched tasks.
  const ordered: Array<{ readonly checkout: string; readonly touched: number }> = [];
  for (const checkout of checkouts) {
    const stat = yield* fs.stat(checkout).pipe(Effect.orElseSucceed(() => null));
    if (!stat) continue;
    const touched =
      checkout === path.resolve(input.projectCwd)
        ? Number.POSITIVE_INFINITY
        : (Option.getOrUndefined(stat.mtime)?.getTime() ?? 0);
    ordered.push({ checkout, touched });
  }
  ordered.sort((a, b) => b.touched - a.touched);

  const volume = (yield* fs.stat(target)).dev;
  const cloned: Array<string> = [];
  for (const lockfile of lockfiles) {
    const dir = path.dirname(lockfile);
    const wanted = yield* fs.readFile(path.join(target, lockfile));
    for (const { checkout } of ordered) {
      const source = path.join(checkout, dir, "node_modules");
      const sourceStat = yield* fs.stat(source).pipe(Effect.orElseSucceed(() => null));
      if (sourceStat?.type !== "Directory" || sourceStat.dev !== volume) continue;
      const theirs = yield* fs
        .readFile(path.join(checkout, lockfile))
        .pipe(Effect.orElseSucceed(() => null));
      if (theirs === null || !sameBytes(theirs, wanted)) continue;
      const destination = path.join(target, dir, "node_modules");
      const copied = yield* runner
        .run({ command: "/bin/cp", args: ["-cR", source, destination] })
        .pipe(Effect.orElseSucceed(() => null));
      if (copied?.code === 0) {
        cloned.push(dir);
        break;
      }
      yield* fs.remove(destination, { recursive: true }).pipe(Effect.ignore);
    }
  }
  return cloned;
});

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}
