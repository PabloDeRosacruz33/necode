import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  expoGoUrl,
  pickIosScheme,
  resolveIosSimulatorPlan as resolve,
} from "./iosSimulatorPlan.ts";

/** Detection only runs on a Mac (where Xcode builds); tests pretend to be one. */
const resolveIosSimulatorPlan = (cwd: string) =>
  resolve(cwd).pipe(Effect.provideService(HostProcess.Platform, "darwin"));

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
        assert.include(plan?.build, "[ -f ios/Podfile ] || CI=1 npx expo prebuild --platform ios");
        // A half-made Pods folder must not skip the install.
        assert.include(plan?.build, "cmp -s ios/Podfile.lock ios/Pods/Manifest.lock");
        // Pods that point at another folder are reinstalled.
        assert.include(plan?.build, 'grep -rqsF "$(pwd -P)/" "ios/Pods/Target Support Files"');
        assert.include(plan?.build, "-configuration Release");
        // The live variant builds in Debug and serves the code from Metro on 8081.
        assert.include(plan?.dev?.build, "-configuration Debug");
        assert.include(plan?.dev?.build, `cd '${cwd}/apps/mobile'`);
        assert.include(plan?.dev?.server, `cd '${cwd}/apps/mobile'`);
        assert.include(plan?.dev?.server, "npx expo start --lan --port 8081");
        // Expo Go can open it, with no build (Simular → Expo Go).
        assert.isTrue(plan?.expo);
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
        assert.isUndefined(plan?.dev);
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
        const plan = yield* resolve(cwd).pipe(Effect.provideService(HostProcess.Platform, "linux"));
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

  it.effect("keeps t3.json's build and fills in the live variant it does not set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* project({
          "t3.json": encodeJson({
            iosSimulator: { build: "npm run sim", devServer: "npm run dev:mobile" },
          }),
          "apps/mobile/package.json": encodeJson({ dependencies: { expo: "54.0.0" } }),
        });
        const plan = yield* resolveIosSimulatorPlan(cwd);
        assert.equal(plan?.build, "npm run sim");
        assert.equal(plan?.dev?.server, "npm run dev:mobile");
        assert.include(plan?.dev?.build, "-configuration Debug");
      }),
    ),
  );
});

describe("expoGoUrl", () => {
  it("is an exp:// address on the local network, on Metro's port", () => {
    const url = expoGoUrl();
    // A CI machine may have no network; with one, the address is IPv4 and never loopback.
    if (url !== null) {
      assert.match(url, /^exp:\/\/\d+\.\d+\.\d+\.\d+:8081$/);
      assert.notInclude(url, "127.0.0.1");
    }
    assert.match(expoGoUrl(8090) ?? "exp://0.0.0.0:8090", /:8090$/);
  });
});
