/**
 * How "Simular" builds a project's iOS app when its t3.json says nothing: finds an Expo,
 * React Native or native Xcode iOS app in the thread's folder and writes the build command for a
 * self-contained simulator app (JavaScript bundled in, so it runs without a dev server). The
 * command prints the built `.app` last, which is how the build finds it (see macApp.ts).
 * A t3.json `iosSimulator` always wins, for projects that need their own steps.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";

export interface IosSimulatorPlan {
  readonly build: string;
  readonly appPath?: string;
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

/** The build "Simular" runs in `cwd`, or null when the project has no iOS app this Mac can build. */
export const resolveIosSimulatorPlan = Effect.fn("iosSimulatorPlan.resolve")(function* (
  cwd: string,
) {
  const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const configured = Option.getOrNull(yield* loader.load(cwd))?.iosSimulator;
  if (configured) return configured satisfies IosSimulatorPlan;
  if ((yield* HostProcessPlatform) !== "darwin") return null;

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
      "-sdk iphonesimulator -destination 'generic/platform=iOS Simulator'",
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
    const steps = [
      "set -e",
      pruneOldBuilds,
      `cd ${quote(found.dir)}`,
      ...(install ? [install] : []),
      // A generated native folder is regenerated so it matches the app's config; a committed one
      // is the project's own and is left alone.
      ...(found.expo
        ? [
            "git ls-files --error-unmatch ios >/dev/null 2>&1 || CI=1 npx expo prebuild --platform ios",
          ]
        : []),
      "[ ! -f ios/Podfile ] || [ -d ios/Pods ] || (cd ios && pod install)",
      'WORKSPACE=$(ls -d ios/*.xcworkspace | head -1); SCHEME=$(basename "$WORKSPACE" .xcworkspace)',
      // Release bundles the JavaScript into the app.
      xcodebuild("-workspace", '"$WORKSPACE"', '"$SCHEME"', "Release"),
      printApp,
    ];
    return { build: steps.join("\n") } satisfies IosSimulatorPlan;
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
    "[ ! -f Podfile ] || [ -d Pods ] || pod install",
    xcodebuild(
      found.container.endsWith(".xcworkspace") ? "-workspace" : "-project",
      quote(found.container),
      quote(found.scheme),
      "Debug",
    ),
    printApp,
  ];
  return { build: steps.join("\n") } satisfies IosSimulatorPlan;
}, Effect.provide(T3ProjectFileLoader.layer));
