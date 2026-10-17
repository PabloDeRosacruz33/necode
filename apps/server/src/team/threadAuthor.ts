import * as Effect from "effect/Effect";

/**
 * The team member who sent a thread's latest message: whose work the thread is now, for sending
 * them what it opens (pages, simulators). Orchestration v2 messages do not record their team
 * author yet, so every thread is unattributed and opens go to every device watching it.
 */
export const latestAuthorMemberId = (_threadId: string) => Effect.succeed<string | null>(null);
