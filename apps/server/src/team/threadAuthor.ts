import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as TeamService from "./TeamService.ts";

/**
 * The team member who sent a thread's latest message: whose work the thread is now, for sending
 * them what it opens (pages, simulators). Null for unattributed threads.
 */
export const latestAuthorMemberId = (threadId: string) =>
  Effect.serviceOption(TeamService.TeamService).pipe(
    Effect.flatMap((team) =>
      Option.isSome(team) ? team.value.latestAuthorForThread(threadId) : Effect.succeed(null),
    ),
  );
