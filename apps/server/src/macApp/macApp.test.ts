import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { archiveMacApp, runMacAppBuild } from "./macApp.ts";

// Builds a minimal app bundle, then prints its path the way real build scripts do.
const FAKE_BUILD = [
  "mkdir -p out/Demo.app/Contents",
  "/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string pro.necora.demo' out/Demo.app/Contents/Info.plist >/dev/null",
  'echo "Resultado: $PWD/out/Demo.app"',
].join(" && ");

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const withProject = (build: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "mac-app-" });
    yield* fs.writeFileString(path.join(cwd, "t3.json"), encodeJson({ macApp: { build } }));
    return yield* fs.realPath(cwd);
  });

const collect = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((items) => Array.from(items)),
  );

it.layer(NodeServices.layer)("runMacAppBuild", (it) => {
  it.effect("finds the app the build printed and reads its bundle id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProject(FAKE_BUILD);

        const events = yield* collect(runMacAppBuild(cwd));

        assert.deepStrictEqual(events[0], { _tag: "started", command: FAKE_BUILD });
        assert.deepStrictEqual(events.at(-1), {
          _tag: "finished",
          exitCode: 0,
          app: { path: `${cwd}/out/Demo.app`, name: "Demo", bundleId: "pro.necora.demo" },
        });

        const zip = (yield* collect(archiveMacApp(`${cwd}/out/Demo.app`)))
          .map((chunk) => chunk.data)
          .join("");
        assert.isAbove(Buffer.from(zip, "base64").length, 0);
      }),
    ),
  );

  it.effect("reports a failed build without an app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* withProject("echo broken >&2; exit 2");

        const events = yield* collect(runMacAppBuild(cwd));

        const output = events.flatMap((event) => (event._tag === "output" ? [event.text] : []));
        assert.include(output.join(""), "broken");
        assert.deepStrictEqual(events.at(-1), { _tag: "finished", exitCode: 2, app: null });
      }),
    ),
  );

  it.effect("builds the iOS simulator app with its own command when asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "sim-app-" }));
        const build = [
          "mkdir -p out/Demo.app",
          "/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string pro.necora.mobile' out/Demo.app/Info.plist >/dev/null",
        ].join(" && ");
        yield* fs.writeFileString(
          path.join(cwd, "t3.json"),
          encodeJson({
            macApp: { build: "exit 9" },
            iosSimulator: { build, appPath: "out/Demo.app" },
          }),
        );

        const events = yield* collect(runMacAppBuild(cwd, "ios-simulator"));

        assert.deepStrictEqual(events.at(-1), {
          _tag: "finished",
          exitCode: 0,
          app: { path: `${cwd}/out/Demo.app`, name: "Demo", bundleId: "pro.necora.mobile" },
        });
      }),
    ),
  );
});
