/**
 * How "Simular" builds a project's iOS app when its t3.json says nothing: finds an Expo,
 * React Native or native Xcode iOS app in the thread's folder and writes the build command for a
 * self-contained simulator app (JavaScript bundled in, so it runs without a dev server). The
 * command prints the built `.app` last, which is how the build finds it (see macApp.ts).
 * A t3.json `iosSimulator` always wins, for projects that need their own steps.
 */
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";

export interface IosSimulatorPlan {
  readonly build: string;
  readonly appPath?: string;
  /**
   * The live variant, for apps whose code comes from a dev server (Expo, React Native): a
   * development build that loads it from localhost:8081, and the command that serves it there.
   */
  readonly dev?: { readonly build: string; readonly server: string };
  /** An Expo app: Expo Go can run it from the dev server, with no build. */
  readonly expo?: boolean;
  /** The Expo app's folder, where its Expo SDK is installed. */
  readonly expoDir?: string;
}

/**
 * Where Expo Go reaches the dev server of this Mac: its address on the local network, the one
 * `expo start --lan` announces. Wired before Wi-Fi; null when the Mac has no network.
 */
export function expoGoUrl(port = 8081): string | null {
  const interfaces = NodeOS.networkInterfaces();
  const names = Object.keys(interfaces).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  for (const name of names) {
    for (const address of interfaces[name] ?? []) {
      if (address.family === "IPv4" && !address.internal) return `exp://${address.address}:${port}`;
    }
  }
  return null;
}

/** Deep enough for monorepos (`apps/mobile/ios`), shallow enough to stay instant. */
const MAX_DEPTH = 3;
const SKIPPED = new Set([
  "node_modules",
  "Pods",
  "build",
  "DerivedData",
  "dist",
  "vendor",
  "Carthage",
]);

const LOCKFILE_INSTALLS: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["package-lock.json", "npm ci --no-audit --no-fund"],
];

const Dependencies = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));
const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ dependencies: Dependencies, devDependencies: Dependencies }),
  ),
);

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type Found =
  | { readonly kind: "javascript"; readonly dir: string; readonly expo: boolean }
  | {
      readonly kind: "xcode";
      readonly dir: string;
      readonly container: string;
      readonly scheme: string;
      /** The project is generated from XcodeGen's project.yml. */
      readonly xcodegen: boolean;
    };

/** The scheme that builds the iOS app: one named for iOS, else one not for macOS, else the project's name. */
export const pickIosScheme = (schemes: ReadonlyArray<string>, fallback: string) =>
  schemes.find((scheme) => /ios/i.test(scheme)) ??
  schemes.find((scheme) => !/mac/i.test(scheme)) ??
  fallback;

/** Scheme names declared under `schemes:` in an XcodeGen project.yml. */
const xcodegenSchemes = (yaml: string) => {
  const block = /^schemes:\n((?:[ \t]+.*\n|\n)*)/m.exec(`${yaml}\n`)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([^\s#][^:]*):\s*$/gm)].map((match) => match[1]!.trim());
};

const findApp = Effect.fn("iosSimulatorPlan.find")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readPackage = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.getOrNull(decodePackageJson(text))),
      Effect.orElseSucceed(() => null),
    );
  const isIosProject = (xcodeproj: string) =>
    fs.readFileString(path.join(xcodeproj, "project.pbxproj")).pipe(
      Effect.map((text) => /SDKROOT = iphoneos;/.test(text)),
      Effect.orElseSucceed(() => false),
    );
  const sharedSchemes = (container: string) =>
    fs.readDirectory(path.join(container, "xcshareddata", "xcschemes")).pipe(
      Effect.map((names) =>
        names.filter((name) => name.endsWith(".xcscheme")).map((name) => name.slice(0, -9)),
      ),
      Effect.orElseSucceed((): Array<string> => []),
    );

  let level = [root];
  let xcode: Found | null = null;
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: Array<string> = [];
    for (const dir of level) {
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      if (entries.includes("package.json")) {
        const pkg = yield* readPackage(path.join(dir, "package.json"));
        const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
        const expo = "expo" in deps;
        if ((expo || "react-native" in deps) && (expo || entries.includes("ios"))) {
          return { kind: "javascript", dir, expo } satisfies Found;
        }
      }
      if (xcode === null) {
        const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
        const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
        const spec = entries.includes("project.yml")
          ? yield* fs
              .readFileString(path.join(dir, "project.yml"))
              .pipe(Effect.orElseSucceed(() => ""))
          : "";
        const specName = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(spec)?.[1];
        const xcodegen = specName !== undefined && /platform:\s*\[?[^\n]*\biOS\b/.test(spec);
        const projectName = xcodegen ? `${specName}.xcodeproj` : project;
        if (projectName && (xcodegen || (yield* isIosProject(path.join(dir, projectName))))) {
          // CocoaPods projects build through the workspace `pod install` creates.
          const podsWorkspace = entries.includes("Podfile")
            ? projectName.replace(/\.xcodeproj$/, ".xcworkspace")
            : undefined;
          const container = workspace ?? podsWorkspace ?? projectName;
          const schemes = [
            ...(yield* sharedSchemes(path.join(dir, container))),
            ...(yield* sharedSchemes(path.join(dir, projectName))),
            ...xcodegenSchemes(spec),
          ];
          xcode = {
            kind: "xcode",
            dir,
            container,
            scheme: pickIosScheme(schemes, projectName.replace(/\.xcodeproj$/, "")),
            xcodegen,
          };
        }
      }
      for (const entry of entries) {
        if (
          entry.startsWith(".") ||
          SKIPPED.has(entry) ||
          /\.(xcodeproj|xcworkspace|app)$/.test(entry)
        ) {
          continue;
        }
        const child = path.join(dir, entry);
        const stat = yield* fs.stat(child).pipe(Effect.orElseSucceed(() => null));
        if (stat?.type === "Directory") next.push(child);
      }
    }
    level = next;
  }
  return xcode;
});

/** Installs the JavaScript dependencies with the lockfile's tool, unless they are already there. */
const installStep = Effect.fn("iosSimulatorPlan.install")(function* (root: string, dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let current = dir; ; current = path.dirname(current)) {
    for (const [lockfile, install] of LOCKFILE_INSTALLS) {
      if (yield* fs.exists(path.join(current, lockfile)).pipe(Effect.orElseSucceed(() => false))) {
        return `[ -d node_modules ] || (cd ${quote(current)} && ${install})`;
      }
    }
    if (current === root || current === path.dirname(current)) return null;
  }
});

/**
 * The build "Simular" runs in `cwd`, or null when the project has no iOS app this Mac can build.
 * t3.json's `iosSimulator` wins field by field; detection fills in the live variant it omits.
 */
export const resolveIosSimulatorPlan = Effect.fn("iosSimulatorPlan.resolve")(function* (
  cwd: string,
) {
  const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const configured = Option.getOrNull(yield* loader.load(cwd))?.iosSimulator;
  const detected: IosSimulatorPlan | null =
    (yield* HostProcess.Platform) === "darwin" && !(configured?.devBuild && configured.devServer)
      ? yield* detectIosSimulatorPlan(cwd)
      : null;
  const build = configured?.build ?? detected?.build;
  if (!build) return null;
  const devBuild = configured?.devBuild ?? detected?.dev?.build;
  const devServer = configured?.devServer ?? detected?.dev?.server;
  return {
    build,
    ...(configured?.appPath ? { appPath: configured.appPath } : {}),
    ...(devBuild && devServer ? { dev: { build: devBuild, server: devServer } } : {}),
    ...(detected?.expo ? { expo: true } : {}),
    ...(detected?.expoDir ? { expoDir: detected.expoDir } : {}),
  } satisfies IosSimulatorPlan;
}, Effect.provide(T3ProjectFileLoader.layer));

/** The plan for the iOS app found in `cwd`, or null when there is none. */
const detectIosSimulatorPlan = Effect.fn("iosSimulatorPlan.detect")(function* (cwd: string) {
  const found = yield* findApp(cwd);
  if (!found) return null;
  const path = yield* Path.Path;
  // One build folder per thread folder, so incremental builds stay fast and never mix projects.
  let hash = 5381;
  for (const char of cwd) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  const derivedData = path.join(
    "${TMPDIR:-/tmp}",
    "necode-simulator",
    `${path.basename(cwd).replace(/[^\w.-]/g, "_")}-${hash.toString(36)}`,
  );
  /** `container` and `scheme` are already shell words. */
  const xcodebuild = (
    flag: "-workspace" | "-project",
    container: string,
    scheme: string,
    configuration: string,
  ) =>
    [
      "xcodebuild",
      flag,
      container,
      "-scheme",
      scheme,
      "-configuration",
      configuration,
      // One architecture, like a build for a chosen device: the generic destination would also
      // build x86_64, which doubles the time and fails on arm64-only vendored frameworks.
      "-sdk iphonesimulator -destination 'generic/platform=iOS Simulator' ARCHS=arm64 ONLY_ACTIVE_ARCH=YES",
      `-derivedDataPath "${derivedData}"`,
      // Signed to run locally: the simulator needs no Apple account, but apps with entitlements
      // (keychain, app groups) only launch with a signature.
      "CODE_SIGN_IDENTITY=- -quiet build",
    ].join(" ");
  const printApp = `ls -dt "${derivedData}"/Build/Products/*-iphonesimulator/*.app | head -1`;
  // Each build folder takes gigabytes; the ones no thread has simulated from in two days go.
  const pruneOldBuilds = `find "\${TMPDIR:-/tmp}/necode-simulator" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} + 2>/dev/null || true`;

  if (found.kind === "javascript") {
    const install = yield* installStep(cwd, found.dir);
    const prepare = [`cd ${quote(found.dir)}`, ...(install ? [install] : [])];
    const steps = (configuration: "Release" | "Debug") => [
      "set -e",
      pruneOldBuilds,
      ...prepare,
      // The native folder is generated once and kept: regenerating it on every build threw the
      // installed pods away and broke a build already running in it. Delete ios/ to regenerate
      // after changing the app's config.
      ...(found.expo
        ? ["[ -f ios/Podfile ] || CI=1 npx expo prebuild --platform ios --no-install"]
        : []),
      // CocoaPods' own staleness check: a Pods folder left half-made, or older than the
      // Podfile.lock, installs again.
      // Pods record this folder's absolute path. Pods made in another task folder (copied,
      // or left from before a rename) still point there and fail once it is deleted.
      '[ ! -d ios/Pods ] || grep -rqsF "$(pwd -P)/" "ios/Pods/Target Support Files" || rm -rf ios/Pods',
      "[ ! -f ios/Podfile ] || cmp -s ios/Podfile.lock ios/Pods/Manifest.lock || (cd ios && pod install)",
      "WORKSPACE=$(ls -d ios/*.xcworkspace 2>/dev/null | head -1)",
      '[ -n "$WORKSPACE" ] || { echo "No .xcworkspace in ios/ after pod install." >&2; exit 1; }',
      'SCHEME=$(basename "$WORKSPACE" .xcworkspace)',
      // Release bundles the JavaScript into the app; Debug loads it from localhost:8081.
      xcodebuild("-workspace", '"$WORKSPACE"', '"$SCHEME"', configuration),
      printApp,
    ];
    return {
      build: steps("Release").join("\n"),
      dev: {
        build: steps("Debug").join("\n"),
        server: [
          ...prepare,
          // On the local network, so Expo Go on a phone or another Mac's simulator reaches it.
          found.expo ? "npx expo start --lan --port 8081" : "npx react-native start --port 8081",
        ].join(" && "),
      },
      ...(found.expo ? { expo: true, expoDir: found.dir } : {}),
    } satisfies IosSimulatorPlan;
  }

  const steps = [
    "set -e",
    pruneOldBuilds,
    `cd ${quote(found.dir)}`,
    // A generated project is regenerated so it matches project.yml; a committed one is left alone.
    ...(found.xcodegen
      ? [
          `git ls-files --error-unmatch ${quote(found.container)} >/dev/null 2>&1 || xcodegen generate`,
        ]
      : []),
    "[ ! -f Podfile ] || cmp -s Podfile.lock Pods/Manifest.lock || pod install",
    xcodebuild(
      found.container.endsWith(".xcworkspace") ? "-workspace" : "-project",
      quote(found.container),
      quote(found.scheme),
      "Debug",
    ),
    printApp,
  ];
  return { build: steps.join("\n") } satisfies IosSimulatorPlan;
});
