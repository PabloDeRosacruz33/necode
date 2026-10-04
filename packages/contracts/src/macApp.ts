import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Building a project's macOS app from a thread's folder and running it on the user's Mac.
 * The environment builds (it has the code); the client opens the result, downloading it first
 * when the environment is another machine, and always replaces the copy that was running.
 */
export const MacAppBuildInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** `ios-simulator` builds t3.json's `iosSimulator` instead of its `macApp`. */
  target: Schema.optional(Schema.Literals(["mac", "ios-simulator"])),
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
