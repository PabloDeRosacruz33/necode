import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Necode: the latest output of a command an agent left running in the background (a build, a
 * deploy), so people can see what it is doing while the thread waits for it.
 */
export const BackgroundTaskOutputInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
});
export type BackgroundTaskOutputInput = typeof BackgroundTaskOutputInput.Type;

export const BackgroundTaskOutputResult = Schema.Struct({
  /** Null when the provider keeps no readable output for the task. */
  output: Schema.NullOr(Schema.String),
  /** The output is only its end. */
  truncated: Schema.Boolean,
});
export type BackgroundTaskOutputResult = typeof BackgroundTaskOutputResult.Type;
