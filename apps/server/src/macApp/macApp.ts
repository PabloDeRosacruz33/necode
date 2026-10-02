/**
 * "Compilar y abrir app Mac": builds the project's macOS app in a thread's folder with the
 * command from its t3.json (`macApp.build`), finds the `.app` it produced, and serves it zipped
 * so a client on another Mac can run it there. Opening on this machine replaces any running copy.
 */
import { MacAppError, type MacAppBuildEvent, type MacAppBuilt } from "@t3tools/contracts";
import { findBuiltAppPath, quitMacAppCommand, readBundleIdCommand } from "@t3tools/shared/macApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProcessRunner from "../processRunner.ts";

/** Enough of the end of the log to find the `.app` path the build printed last. */
const OUTPUT_TAIL_BYTES = 64_000;

const fail = (message: string) => new MacAppError({ message });

const run = (command: { command: string; args: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner
      .run({ command: command.command, args: command.args })
      .pipe(Effect.orElseSucceed(() => null));
  });

const describeApp = Effect.fn("macApp.describe")(function* (appPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !appPath.endsWith(".app") ||
    !(yield* fs.exists(appPath).pipe(Effect.orElseSucceed(() => false)))
  ) {
    return null;
  }
  const bundle = yield* run(readBundleIdCommand(appPath));
  return {
    path: appPath,
    name: path.basename(appPath, ".app"),
    bundleId: bundle?.code === 0 ? bundle.stdout.trim() || null : null,
  } satisfies MacAppBuilt;
});

export const runMacAppBuild = (cwd: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
      const path = yield* Path.Path;
      const config = Option.getOrNull(yield* loader.load(cwd))?.macApp;
      if (!config) {
        return yield* fail("This project's t3.json has no macApp.build command.");
      }
      const runner = yield* ProcessRunner.ProcessRunner;
      const commonDir = yield* runner
        .run({
          command: "git",
          args: ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        })
        .pipe(
          Effect.map((output) => output.stdout.trim()),
          Effect.orElseSucceed(() => ""),
        );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner
        .spawn(
          ChildProcess.make("/bin/sh", ["-lc", config.build], {
            cwd,
            env: {
              T3CODE_PROJECT_ROOT: commonDir ? path.dirname(commonDir) : cwd,
              T3CODE_WORKTREE_PATH: cwd,
            },
            extendEnv: true,
          }),
        )
        .pipe(Effect.mapError((cause) => fail(`Could not start the build: ${cause.message}`)));
      const tail = yield* Ref.make("");
      const output = Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.tap((text) =>
          Ref.update(tail, (current) => (current + text).slice(-OUTPUT_TAIL_BYTES)),
        ),
        Stream.map((text): MacAppBuildEvent => ({ _tag: "output", text })),
        Stream.mapError((cause) => fail(`The build's output could not be read: ${String(cause)}`)),
      );
      const finished = Stream.fromEffect(
        Effect.gen(function* () {
          const exitCode = Number(
            yield* child.exitCode.pipe(
              Effect.mapError((cause) => fail(`The build did not finish: ${String(cause)}`)),
            ),
          );
          const appPath =
            exitCode !== 0
              ? null
              : config.appPath
                ? path.resolve(cwd, config.appPath)
                : findBuiltAppPath(yield* Ref.get(tail));
          const app = appPath ? yield* describeApp(appPath) : null;
          return { _tag: "finished", exitCode, app } satisfies MacAppBuildEvent;
        }),
      );
      const started: MacAppBuildEvent = { _tag: "started", command: config.build };
      return Stream.make(started).pipe(Stream.concat(output), Stream.concat(finished));
    }),
  ).pipe(Stream.provide(Layer.mergeAll(T3ProjectFileLoader.layer, ProcessRunner.layer)));

/** The app zipped with ditto (keeping its signature and symlinks), streamed in base64 pieces. */
export const archiveMacApp = (appPath: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      if (!(yield* describeApp(appPath))) {
        return yield* fail(`${appPath} is not a built app.`);
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner
        .spawn(
          ChildProcess.make("/usr/bin/ditto", [
            "-c",
            "-k",
            "--sequesterRsrc",
            "--keepParent",
            appPath,
            "-",
          ]),
        )
        .pipe(Effect.mapError((cause) => fail(`Could not pack the app: ${cause.message}`)));
      return child.stdout.pipe(
        Stream.map((bytes) => ({ data: Buffer.from(bytes).toString("base64") })),
        Stream.mapError((cause) => fail(`Packing the app failed: ${String(cause)}`)),
      );
    }),
  ).pipe(Stream.provide(ProcessRunner.layer));

export const quitMacApp = Effect.fn("macApp.quit")(function* (bundleId: string) {
  yield* run(quitMacAppCommand(bundleId));
}, Effect.provide(ProcessRunner.layer));

export const openMacApp = Effect.fn("macApp.open")(function* (input: {
  readonly appPath: string;
  readonly bundleId: string | null;
}) {
  const app = yield* describeApp(input.appPath);
  if (!app) return yield* fail(`${input.appPath} is not a built app.`);
  const bundleId = input.bundleId ?? app.bundleId;
  if (bundleId) yield* run(quitMacAppCommand(bundleId));
  const opened = yield* run({ command: "/usr/bin/open", args: [input.appPath] });
  if (opened?.code !== 0) return yield* fail(`Could not open ${app.name}.`);
}, Effect.provide(ProcessRunner.layer));
