import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Building a project's macOS app from a thread's folder and running it on the user's Mac.
 * The environment builds (it has the code); the client opens the result, downloading it first
 * when the environment is another machine, and always replaces the copy that was running.
 */
export const MacAppBuildInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /**
   * `ios-simulator` builds the project's iOS app for the simulator instead of its `macApp`;
   * `ios-simulator-dev` builds its development app, which loads its code from the dev server.
   */
  target: Schema.optional(Schema.Literals(["mac", "ios-simulator", "ios-simulator-dev"])),
});
export type MacAppBuildInput = typeof MacAppBuildInput.Type;

export const MacAppBuilt = Schema.Struct({
  /** Absolute path of the built `.app` on the environment. */
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  bundleId: Schema.NullOr(TrimmedNonEmptyString),
});
export type MacAppBuilt = typeof MacAppBuilt.Type;

export const MacAppBuildEvent = Schema.Union([
  Schema.TaggedStruct("started", { command: TrimmedNonEmptyString }),
  Schema.TaggedStruct("output", { text: Schema.String }),
  /** `app` is null when the build failed or no `.app` could be found. */
  Schema.TaggedStruct("finished", {
    exitCode: Schema.NullOr(Schema.Int),
    app: Schema.NullOr(MacAppBuilt),
  }),
]);
export type MacAppBuildEvent = typeof MacAppBuildEvent.Type;

/** Whether "Simular" can build the iOS app in `cwd`: t3.json's `iosSimulator`, or one found there. */
export const MacAppIosSimulatorPlanInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type MacAppIosSimulatorPlanInput = typeof MacAppIosSimulatorPlanInput.Type;

export const MacAppIosSimulatorPlan = Schema.NullOr(
  Schema.Struct({
    build: TrimmedNonEmptyString,
    /** Starts the dev server; present when the app can also run live (Expo, React Native). */
    devServer: Schema.optional(TrimmedNonEmptyString),
    /**
     * Expo apps: the address Expo Go opens to load the app from that dev server, on the
     * environment's local network (exp://<its LAN address>:8081).
     */
    expoGoUrl: Schema.optional(TrimmedNonEmptyString),
  }),
);
export type MacAppIosSimulatorPlan = typeof MacAppIosSimulatorPlan.Type;

export const MacAppArchiveInput = Schema.Struct({ appPath: TrimmedNonEmptyString });
export type MacAppArchiveInput = typeof MacAppArchiveInput.Type;

/** A piece of the `.app` zipped with `ditto`, base64-encoded. */
export const MacAppArchiveChunk = Schema.Struct({ data: Schema.String });
export type MacAppArchiveChunk = typeof MacAppArchiveChunk.Type;

/** Runs the app on the environment's own Mac, replacing any copy already running. */
export const MacAppOpenInput = Schema.Struct({
  appPath: TrimmedNonEmptyString,
  bundleId: Schema.NullOr(TrimmedNonEmptyString),
});
export type MacAppOpenInput = typeof MacAppOpenInput.Type;

export const MacAppQuitInput = Schema.Struct({ bundleId: TrimmedNonEmptyString });
export type MacAppQuitInput = typeof MacAppQuitInput.Type;

export class MacAppError extends Schema.TaggedError<MacAppError>()("MacAppError", {
  message: TrimmedNonEmptyString,
}) {}
