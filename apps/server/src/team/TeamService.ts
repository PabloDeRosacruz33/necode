// @effect-diagnostics nodeBuiltinImport:off -- member ids and the owner's default name come from Node.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  TEAM_MEMBER_COLORS,
  TEAM_OWNER_MEMBER_ID,
  TEAM_ROLE_SCOPES,
  TeamError,
  type TeamInviteInput,
  type TeamInviteResult,
  type TeamMember,
  type TeamMemberRole,
  type TeamPresence,
  type TeamSnapshot,
  type TeamUpdateMemberInput,
  type ThreadId,
  teamMemberIdFromSubject,
  teamMemberSubject,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

/** Invites travel over chat apps, so they outlive the 5-minute device pairing default. */
const INVITE_TTL = Duration.days(7);

interface MemberRow {
  readonly memberId: string;
  readonly name: string;
  readonly color: string;
  readonly role: TeamMemberRole;
  readonly createdAt: string;
  readonly gitName: string | null;
  readonly gitEmail: string | null;
}

/** Who a commit is by, as git's author and committer. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** The variables that make git sign commits as `identity`, or none for the machine's own. */
export const gitIdentityEnvironment = (
  identity: GitIdentity | null,
): Readonly<Record<string, string>> =>
  identity
    ? {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      }
    : {};

interface Connection {
  readonly memberId: string | null;
  readonly viewingThreadId: ThreadId | null;
}

export interface TeamServiceShape {
  readonly listMembers: Effect.Effect<ReadonlyArray<TeamMember>, TeamError>;
  readonly invite: (input: TeamInviteInput) => Effect.Effect<TeamInviteResult, TeamError>;
  readonly revokeMember: (memberId: string) => Effect.Effect<boolean, TeamError>;
  readonly updateMember: (input: TeamUpdateMemberInput) => Effect.Effect<TeamMember, TeamError>;
  /** The git identity of whoever sent a thread's latest message, when they set one. */
  readonly gitIdentityForThread: (threadId: string) => Effect.Effect<GitIdentity | null>;
  readonly gitIdentityForMember: (memberId: string) => Effect.Effect<GitIdentity | null>;
  /** Tracks a live WebSocket for presence until `disconnect`. */
  readonly connect: (input: {
    readonly connectionId: string;
    readonly subject: string;
  }) => Effect.Effect<void>;
  readonly disconnect: (connectionId: string) => Effect.Effect<void>;
  readonly setViewing: (connectionId: string, threadId: ThreadId | null) => Effect.Effect<void>;
  /** Current snapshot followed by a fresh one after every membership or presence change. */
  readonly subscribe: (subject: string) => Stream.Stream<TeamSnapshot, TeamError>;
}

export class TeamService extends Context.Service<TeamService, TeamServiceShape>()(
  "t3/team/TeamService",
) {}

const isTeamError = Schema.is(TeamError);

const toTeamError = (message: string) => (cause: unknown) =>
  new TeamError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const toMember = (row: MemberRow): TeamMember => ({
  memberId: row.memberId,
  name: row.name,
  color: row.color,
  role: row.role,
  createdAt: DateTime.makeUnsafe(row.createdAt),
  ...(row.gitName && row.gitEmail ? { gitName: row.gitName, gitEmail: row.gitEmail } : {}),
});

/** First word of the OS account name, capitalised: "pabloderosacruz" becomes "Pabloderosacruz". */
const defaultOwnerName = (): string => {
  const username = NodeOS.userInfo().username.trim() || "Owner";
  return username.charAt(0).toUpperCase() + username.slice(1);
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const connections = yield* Ref.make(new Map<string, Connection>());
  const changes = yield* PubSub.unbounded<void>();
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  // Created here rather than in a numbered migration so upstream migrations keep their numbers.
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_member_git_identities (
      member_id TEXT PRIMARY KEY,
      git_name TEXT NOT NULL,
      git_email TEXT NOT NULL
    )
  `.pipe(Effect.mapError(toTeamError("Could not prepare git identities")), Effect.orDie);

  const memberColumns = sql`
    m.member_id AS "memberId",
    m.name,
    m.color,
    m.role,
    m.created_at AS "createdAt",
    g.git_name AS "gitName",
    g.git_email AS "gitEmail"
  `;
  const selectMembers = sql<MemberRow>`
    SELECT ${memberColumns}
    FROM team_members m
    LEFT JOIN team_member_git_identities g ON g.member_id = m.member_id
    WHERE m.revoked_at IS NULL
    ORDER BY m.created_at ASC
  `;

  // The owner always exists so host-issued sessions have someone to attribute to.
  yield* Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO team_members (member_id, name, color, role, created_at)
      VALUES (${TEAM_OWNER_MEMBER_ID}, ${defaultOwnerName()}, ${TEAM_MEMBER_COLORS[0]}, 'owner', ${now})
      ON CONFLICT (member_id) DO NOTHING
    `;
  }).pipe(Effect.mapError(toTeamError("Could not create the team owner")), Effect.orDie);

  const listMembers = selectMembers.pipe(
    Effect.map((rows) => rows.map(toMember)),
    Effect.mapError(toTeamError("Could not load team members")),
  );

  const invite: TeamServiceShape["invite"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM team_members
      `;
      const memberId = NodeCrypto.randomUUID();
      const color = TEAM_MEMBER_COLORS[(rows[0]?.count ?? 0) % TEAM_MEMBER_COLORS.length]!;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO team_members (member_id, name, color, role, created_at)
        VALUES (${memberId}, ${input.name}, ${color}, ${input.role}, ${now})
      `;
      const issued = yield* auth.createPairingLink({
        ttl: INVITE_TTL,
        label: input.name,
        scopes: TEAM_ROLE_SCOPES[input.role],
        subject: teamMemberSubject(memberId),
      });
      yield* notify;
      return {
        member: toMember({
          memberId,
          name: input.name,
          color,
          role: input.role,
          createdAt: now,
          gitName: null,
          gitEmail: null,
        }),
        credential: {
          id: issued.id,
          credential: issued.credential,
          ...(issued.label ? { label: issued.label } : {}),
          expiresAt: issued.expiresAt,
        },
      } satisfies TeamInviteResult;
    }).pipe(Effect.mapError(toTeamError("Could not invite the member")));

  const revokeMember: TeamServiceShape["revokeMember"] = (memberId) =>
    Effect.gen(function* () {
      if (memberId === TEAM_OWNER_MEMBER_ID) {
        return yield* new TeamError({ message: "The owner cannot be removed." });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* sql<{ readonly memberId: string }>`
        UPDATE team_members SET revoked_at = ${now}
        WHERE member_id = ${memberId} AND revoked_at IS NULL
        RETURNING member_id AS "memberId"
      `;
      const subject = teamMemberSubject(memberId);
      // Revoking sessions also closes their live sockets (see the /ws route).
      const sessions = yield* auth.listSessions();
      yield* Effect.forEach(
        sessions.filter((session) => session.subject === subject),
        (session) => auth.revokeSession(session.sessionId),
        { discard: true },
      );
      const links = yield* auth.listPairingLinks();
      yield* Effect.forEach(
        links.filter((link) => link.subject === subject),
        (link) => auth.revokePairingLink(link.id),
        { discard: true },
      );
      yield* notify;
      return updated.length > 0;
    }).pipe(
      Effect.mapError((error) =>
        isTeamError(error) ? error : toTeamError("Could not remove the member")(error),
      ),
    );

  const updateMember: TeamServiceShape["updateMember"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* sql<{ readonly memberId: string }>`
        UPDATE team_members
        SET
          name = COALESCE(${input.name ?? null}, name),
          color = COALESCE(${input.color ?? null}, color)
        WHERE member_id = ${input.memberId} AND revoked_at IS NULL
        RETURNING member_id AS "memberId"
      `;
      if (!updated[0]) {
        return yield* new TeamError({ message: "That member no longer exists." });
      }
      if (input.git === null) {
        yield* sql`DELETE FROM team_member_git_identities WHERE member_id = ${input.memberId}`;
      } else if (input.git) {
        yield* sql`
          INSERT INTO team_member_git_identities (member_id, git_name, git_email)
          VALUES (${input.memberId}, ${input.git.name}, ${input.git.email})
          ON CONFLICT (member_id) DO UPDATE SET git_name = excluded.git_name, git_email = excluded.git_email
        `;
      }
      const rows = yield* sql<MemberRow>`
        SELECT ${memberColumns}
        FROM team_members m
        LEFT JOIN team_member_git_identities g ON g.member_id = m.member_id
        WHERE m.member_id = ${input.memberId}
      `;
      yield* notify;
      return toMember(rows[0]!);
    }).pipe(
      Effect.mapError((error) =>
        isTeamError(error) ? error : toTeamError("Could not update the member")(error),
      ),
    );

  const connect: TeamServiceShape["connect"] = ({ connectionId, subject }) =>
    Ref.update(connections, (current) =>
      new Map(current).set(connectionId, {
        memberId: teamMemberIdFromSubject(subject),
        viewingThreadId: null,
      }),
    ).pipe(Effect.andThen(notify));

  const disconnect: TeamServiceShape["disconnect"] = (connectionId) =>
    Ref.update(connections, (current) => {
      const next = new Map(current);
      next.delete(connectionId);
      return next;
    }).pipe(Effect.andThen(notify));

  const setViewing: TeamServiceShape["setViewing"] = (connectionId, threadId) =>
    Ref.modify(connections, (current) => {
      const connection = current.get(connectionId);
      if (!connection || connection.viewingThreadId === threadId) return [false, current] as const;
      return [
        true,
        new Map(current).set(connectionId, { ...connection, viewingThreadId: threadId }),
      ];
    }).pipe(Effect.flatMap((changed) => (changed ? notify : Effect.void)));

  const presence = Ref.get(connections).pipe(
    Effect.map((current) => {
      const byMember = new Map<string, { connections: number; viewing: Set<ThreadId> }>();
      for (const connection of current.values()) {
        if (connection.memberId === null) continue;
        const entry = byMember.get(connection.memberId) ?? { connections: 0, viewing: new Set() };
        entry.connections += 1;
        if (connection.viewingThreadId !== null) entry.viewing.add(connection.viewingThreadId);
        byMember.set(connection.memberId, entry);
      }
      return [...byMember].map(([memberId, entry]): TeamPresence => ({
        memberId,
        connections: entry.connections,
        viewingThreadIds: [...entry.viewing],
      }));
    }),
  );

  const snapshot = (selfMemberId: string | null) =>
    Effect.all({ members: listMembers, presence }).pipe(
      Effect.map(({ members, presence }): TeamSnapshot => ({ members, presence, selfMemberId })),
    );

  const subscribe: TeamServiceShape["subscribe"] = (subject) => {
    const selfMemberId = teamMemberIdFromSubject(subject);
    // Subscribe before reading the first snapshot so no change falls in between.
    return Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const initial = yield* snapshot(selfMemberId);
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect(() => snapshot(selfMemberId)),
          ),
        );
      }),
    );
  };

  const gitIdentityForMember: TeamServiceShape["gitIdentityForMember"] = (memberId) =>
    sql<GitIdentity>`
      SELECT git_name AS "name", git_email AS "email"
      FROM team_member_git_identities
      WHERE member_id = ${memberId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orElseSucceed(() => null),
    );

  const gitIdentityForThread: TeamServiceShape["gitIdentityForThread"] = (threadId) =>
    sql<GitIdentity>`
      SELECT git_name AS "name", git_email AS "email"
      FROM team_member_git_identities
      WHERE member_id = (
        SELECT author_member_id FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user'
        ORDER BY created_at DESC
        LIMIT 1
      )
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orElseSucceed(() => null),
    );

  return TeamService.of({
    listMembers,
    gitIdentityForThread,
    gitIdentityForMember,
    invite,
    revokeMember,
    updateMember,
    connect,
    disconnect,
    setViewing,
    subscribe,
  });
});

export const layer = Layer.effect(TeamService, make);
