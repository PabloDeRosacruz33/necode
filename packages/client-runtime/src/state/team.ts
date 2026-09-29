import type { TeamMember, TeamSnapshot, ThreadId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const EMPTY_TEAM_SNAPSHOT: TeamSnapshot = { members: [], presence: [], selfMemberId: null };

export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Members and live presence for one environment; a fresh snapshot per change. */
    team: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:team",
      tag: WS_METHODS.teamSubscribe,
    }),
    setViewing: createEnvironmentRpcCommand(runtime, {
      label: "team:set-viewing",
      tag: WS_METHODS.teamSetViewing,
    }),
    invite: createEnvironmentRpcCommand(runtime, {
      label: "team:invite",
      tag: WS_METHODS.teamInvite,
    }),
    revokeMember: createEnvironmentRpcCommand(runtime, {
      label: "team:revoke-member",
      tag: WS_METHODS.teamRevokeMember,
    }),
    updateMember: createEnvironmentRpcCommand(runtime, {
      label: "team:update-member",
      tag: WS_METHODS.teamUpdateMember,
    }),
  };
}

export function findTeamMember(
  snapshot: TeamSnapshot,
  memberId: string | null | undefined,
): TeamMember | undefined {
  if (memberId === null || memberId === undefined) return undefined;
  return snapshot.members.find((member) => member.memberId === memberId);
}

/** Members currently connected, the viewer first, then in join order. */
export function onlineTeamMembers(snapshot: TeamSnapshot): ReadonlyArray<TeamMember> {
  const online = new Set(snapshot.presence.map((entry) => entry.memberId));
  return snapshot.members
    .filter((member) => online.has(member.memberId))
    .toSorted((left, right) =>
      left.memberId === snapshot.selfMemberId
        ? -1
        : right.memberId === snapshot.selfMemberId
          ? 1
          : 0,
    );
}

/** Other members who have this thread open right now. */
export function teamMembersViewingThread(
  snapshot: TeamSnapshot,
  threadId: ThreadId,
): ReadonlyArray<TeamMember> {
  const viewers = new Set(
    snapshot.presence
      .filter(
        (entry) =>
          entry.memberId !== snapshot.selfMemberId && entry.viewingThreadIds.includes(threadId),
      )
      .map((entry) => entry.memberId),
  );
  return snapshot.members.filter((member) => viewers.has(member.memberId));
}

/** Authors are labelled once the environment has more than one member. */
export function shouldLabelMessageAuthor(
  snapshot: TeamSnapshot,
  authorMemberId: string | undefined,
): boolean {
  return (
    authorMemberId !== undefined &&
    snapshot.members.length > 1 &&
    findTeamMember(snapshot, authorMemberId) !== undefined
  );
}

export function teamMemberInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const initials = parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}` : name.slice(0, 2);
  return initials.toUpperCase();
}
