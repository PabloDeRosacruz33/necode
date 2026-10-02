import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Where a parallel copy of a thread comes from: a thread on this same environment, whose agent
 * conversation can be forked, or a conversation brought over from another environment.
 */
export const VcsDuplicateThreadSource = Schema.Union([
  Schema.TaggedStruct("local", { threadId: ThreadId }),
  Schema.TaggedStruct("transferred", {
    /** The same repository's project on this environment. */
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
    /** The source thread's branch, used when starting from where it is (it must be pushed). */
    branch: Schema.NullOr(TrimmedNonEmptyString),
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
        createdAt: IsoDateTime,
      }),
    ),
  }),
]);
export type VcsDuplicateThreadSource = typeof VcsDuplicateThreadSource.Type;

/**
 * A parallel copy of a thread: a new thread with the same history in its own task. On the same
 * environment and provider instance the agent's conversation is forked, so it keeps its context.
 */
export const VcsDuplicateThreadInput = Schema.Struct({
  source: VcsDuplicateThreadSource,
  taskName: TrimmedNonEmptyString,
  /** Start from the integration branch's latest, or from where the source thread is now. */
  from: Schema.Literals(["integration", "current"]),
  branchPrefix: Schema.optional(TrimmedNonEmptyString),
  /** The agent for the copy; the source thread's when omitted. */
  modelSelection: Schema.optional(ModelSelection),
});
export type VcsDuplicateThreadInput = typeof VcsDuplicateThreadInput.Type;

export const VcsDuplicateThreadResult = Schema.Struct({
  threadId: ThreadId,
  branch: TrimmedNonEmptyString,
  /** False when the agent's context could not be forked: the copy has the history only. */
  forked: Schema.Boolean,
});
export type VcsDuplicateThreadResult = typeof VcsDuplicateThreadResult.Type;
