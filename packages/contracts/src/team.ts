import * as Schema from "effect/Schema";

import {
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthPairingCredentialResult,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * People allowed on one environment. The owner is the person running the host;
 * everyone else joins through a one-time invite that binds their sessions to
 * the subject `member:<memberId>`.
 */
export const TeamMemberRole = Schema.Literals(["owner", "member", "viewer"]);
export type TeamMemberRole = typeof TeamMemberRole.Type;

export const TeamInvitableRole = Schema.Literals(["member", "viewer"]);
export type TeamInvitableRole = typeof TeamInvitableRole.Type;

export const TeamMemberId = TrimmedNonEmptyString;
export type TeamMemberId = typeof TeamMemberId.Type;

export const TEAM_OWNER_MEMBER_ID = "owner";
const MEMBER_SUBJECT_PREFIX = "member:";

// Sessions the host itself mints (desktop, startup link, CLI, dev token) act as the owner.
const OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  "desktop-bootstrap",
  "administrative-bootstrap",
  "cli-issued-session",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

export const teamMemberSubject = (memberId: string): string =>
  `${MEMBER_SUBJECT_PREFIX}${memberId}`;

/** The member a session subject belongs to, or null for unattributed legacy devices. */
export function teamMemberIdFromSubject(subject: string): string | null {
  if (subject.startsWith(MEMBER_SUBJECT_PREFIX)) {
    const memberId = subject.slice(MEMBER_SUBJECT_PREFIX.length);
    return memberId.length > 0 ? memberId : null;
  }
  return OWNER_SUBJECTS.has(subject) ? TEAM_OWNER_MEMBER_ID : null;
}

export const TEAM_ROLE_SCOPES: Readonly<
  Record<TeamMemberRole, ReadonlyArray<AuthEnvironmentScope>>
> = {
  owner: AuthAdministrativeScopes,
  member: AuthStandardClientScopes,
  viewer: [AuthOrchestrationReadScope],
};

export const TeamMember = Schema.Struct({
  memberId: TeamMemberId,
  name: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
  role: TeamMemberRole,
  createdAt: Schema.DateTimeUtc,
  /**
   * Who commits made while this member works on a thread are by (its agent, terminals and
   * merges). Unset: the environment machine's own git identity.
   */
  gitName: Schema.optional(TrimmedNonEmptyString),
  gitEmail: Schema.optional(TrimmedNonEmptyString),
});
export type TeamMember = typeof TeamMember.Type;

export const TeamPresence = Schema.Struct({
  memberId: TeamMemberId,
  connections: Schema.Number,
  viewingThreadIds: Schema.Array(ThreadId),
});
export type TeamPresence = typeof TeamPresence.Type;

export const TeamSnapshot = Schema.Struct({
  members: Schema.Array(TeamMember),
  presence: Schema.Array(TeamPresence),
  /** The member behind the subscribing connection; null for legacy devices. */
  selfMemberId: Schema.NullOr(TeamMemberId),
});
export type TeamSnapshot = typeof TeamSnapshot.Type;

export const TeamInviteInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  role: TeamInvitableRole,
});
export type TeamInviteInput = typeof TeamInviteInput.Type;

export const TeamInviteResult = Schema.Struct({
  member: TeamMember,
  credential: AuthPairingCredentialResult,
});
export type TeamInviteResult = typeof TeamInviteResult.Type;

export const TeamRevokeMemberInput = Schema.Struct({
  memberId: TeamMemberId,
});
export type TeamRevokeMemberInput = typeof TeamRevokeMemberInput.Type;

export const TeamUpdateMemberInput = Schema.Struct({
  memberId: TeamMemberId,
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  color: Schema.optionalKey(TrimmedNonEmptyString),
  /** Both together; null clears the member's git identity. */
  git: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
        email: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      }),
    ),
  ),
});
export type TeamUpdateMemberInput = typeof TeamUpdateMemberInput.Type;

export const TeamSetViewingInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});
export type TeamSetViewingInput = typeof TeamSetViewingInput.Type;

export class TeamError extends Schema.TaggedError<TeamError>()("TeamError", {
  message: Schema.String,
}) {}

/** Distinct, readable member colours, assigned in order and reused after the list ends. */
export const TEAM_MEMBER_COLORS = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ef4444",
  "#eab308",
  "#06b6d4",
  "#ec4899",
] as const;
