import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * The team member who sent a thread's latest message: whose work the thread is now, for sending
 * them what it opens (pages, simulators). Null for unattributed threads or unknown ids.
 */
export const latestAuthorMemberId = (threadId: string) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const thread = yield* projection
      .getThreadDetailById(ThreadId.make(threadId), { activityKinds: [] })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return (
      Option.getOrUndefined(thread)?.messages.findLast((message) => message.role === "user")
        ?.authorMemberId ?? null
    );
  });
