import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { pickIosScheme, resolveIosSimulatorPlan as resolve } from "./iosSimulatorPlan.ts";

/** Detection only runs on a Mac (where Xcode builds); tests pretend to be one. */
const resolveIosSimulatorPlan = (cwd: string) =>
  resolve(cwd).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

/** A temporary project with the given files (path → contents). */
const project = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ios-plan-" });
    for (const [file, contents] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, file), contents);
    }
    return cwd;
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const IOS_PBXPROJ = "buildSettings = { SDKROOT = iphoneos; };";

it.layer(NodeServices.layer)("resolveIosSimulatorPlan", (it) => {
  it.effect("builds an Expo app in a monorepo in Release, installing with its lockfile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({
          "pnpm-lock.yaml": "",
          "apps/mobile/package.json": encodeJson({ dependencies: { expo: "54.0.0" } }),
          "apps/web/package.json": encodeJson({ dependencies: { react: "19.0.0" } }),
        });
        const plan = yield* resolveIosSimulatorPlan(cwd);
        assert.include(plan?.build, `cd '${cwd}/apps/mobile'`);
        assert.include(plan?.build, `(cd '${cwd}' && pnpm install --frozen-lockfile)`);
        assert.include(plan?.build, "npx expo prebuild --platform ios");
        assert.include(plan?.build, "-configuration Release");
      }),
    ),
  );

  it.effect("builds a native iOS project through its CocoaPods workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({
          "Demo.xcodeproj/project.pbxproj": IOS_PBXPROJ,
          Podfile: "",
        });
        const plan = yield* resolveIosSimulatorPlan(cwd);
        assert.include(plan?.build, "-workspace 'Demo.xcworkspace' -scheme 'Demo'");
        assert.include(plan?.build, "pod install");
      }),
    ),
  );

  it.effect("finds nothing in a project without an iOS app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({
          "package.json": encodeJson({ dependencies: { react: "19.0.0" } }),
          "Mac.xcodeproj/project.pbxproj": "buildSettings = { SDKROOT = macosx; };",
        });
        assert.isNull(yield* resolveIosSimulatorPlan(cwd));
      }),
    ),
  );

  it.effect("builds an XcodeGen project's iOS scheme, generating the project first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({
          "project.yml": [
            "name: NecoraPro",
            "schemes:",
            "  Necora Pro macOS:",
            "    build: {}",
            "  Necora Pro iOS:",
            "    build: {}",
            "targets:",
            "  NecoraPro:",
            "    type: application",
            "    platform: iOS",
          ].join("\n"),
        });
        const plan = yield* resolveIosSimulatorPlan(cwd);
        assert.include(plan?.build, "xcodegen generate");
        assert.include(plan?.build, "-project 'NecoraPro.xcodeproj' -scheme 'Necora Pro iOS'");
      }),
    ),
  );

  it("picks the iOS scheme of a project that also builds for the Mac", () => {
    assert.equal(pickIosScheme(["App macOS", "App iOS"], "App"), "App iOS");
    assert.equal(pickIosScheme(["App Mac", "App"], "x"), "App");
    assert.equal(pickIosScheme([], "App"), "App");
  });

  it.effect("finds nothing on an environment that is not a Mac", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({ "Demo.xcodeproj/project.pbxproj": IOS_PBXPROJ });
        const plan = yield* resolve(cwd).pipe(Effect.provideService(HostProcessPlatform, "linux"));
        assert.isNull(plan);
      }),
    ),
  );

  it.effect("uses t3.json's iosSimulator over anything found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({
          "t3.json": encodeJson({ iosSimulator: { build: "npm run sim" } }),
          "Demo.xcodeproj/project.pbxproj": IOS_PBXPROJ,
        });
        assert.deepStrictEqual(yield* resolveIosSimulatorPlan(cwd), { build: "npm run sim" });
      }),
    ),
  );
});
