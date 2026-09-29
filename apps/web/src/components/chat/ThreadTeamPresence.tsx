import {
  isViewingThreadReported,
  teamMemberInitials,
  teamMembersViewingThread,
} from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { teamEnvironment, useTeamSnapshot } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MAX_VISIBLE_VIEWERS = 3;

/**
 * Tells the environment which thread this client has open and shows the
 * teammates who have it open too.
 */
export function ThreadTeamPresence(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const setViewing = useAtomCommand(teamEnvironment.setViewing, { reportFailure: false });
  const team = useTeamSnapshot(environmentId);
  // Until a snapshot exists there is nobody to report to; afterwards resend
  // whenever the environment lost track (first connect, reconnect, restart).
  const hasSnapshot = team.selfMemberId !== null;
  const reported = isViewingThreadReported(team, threadId);
  useEffect(() => {
    if (!hasSnapshot || reported) return;
    void setViewing({ environmentId, input: { threadId } });
  }, [environmentId, hasSnapshot, reported, setViewing, threadId]);
  useEffect(
    () => () => {
      void setViewing({ environmentId, input: { threadId: null } });
    },
    [environmentId, setViewing, threadId],
  );

  const viewers = teamMembersViewingThread(team, threadId);
  if (viewers.length === 0) return null;

  const visible = viewers.slice(0, MAX_VISIBLE_VIEWERS);
  const hidden = viewers.length - visible.length;
  const names = viewers.map((member) => member.name).join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="flex shrink-0 items-center -space-x-1.5"
            aria-label={`Also viewing: ${names}`}
          />
        }
      >
        {visible.map((member) => (
          <span
            key={member.memberId}
            className="flex size-5 items-center justify-center rounded-full text-4xs font-semibold text-white ring-2 ring-background"
            style={{ backgroundColor: member.color }}
          >
            {teamMemberInitials(member.name)}
          </span>
        ))}
        {hidden > 0 ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-muted text-4xs font-semibold text-muted-foreground ring-2 ring-background">
            +{hidden}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Also viewing: {names}</TooltipPopup>
    </Tooltip>
  );
}
