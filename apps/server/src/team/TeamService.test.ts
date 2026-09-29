import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  TEAM_OWNER_MEMBER_ID,
  ThreadId,
  teamMemberSubject,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamService from "./TeamService.ts";

const TeamTestLayer = TeamService.layer.pipe(
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.identityLayer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "necode-team-test-" })),
    ),
  ),
);

const requestMetadata = { deviceType: "mobile" as const, os: "iOS" };

const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

it.layer(NodeServices.layer)("TeamService", (it) => {
  it.effect("starts with the host owner", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const members = yield* team.listMembers;
      expect(members.map((member) => [member.memberId, member.role])).toEqual([
        [TEAM_OWNER_MEMBER_ID, "owner"],
      ]);
    }).pipe(Effect.provide(TeamTestLayer)),
  );

  it.effect("binds an invite's sessions to the member and scopes them by role", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;

      const invited = yield* team.invite({ name: "Ana", role: "viewer" });
      const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
        invited.credential.credential,
        undefined,
        requestMetadata,
      );

      const verified = yield* auth.authenticateHttpRequest(bearer(exchanged.access_token));
      expect(verified.subject).toBe(teamMemberSubject(invited.member.memberId));
      expect([...verified.scopes]).toEqual([AuthOrchestrationReadScope]);
      expect((yield* team.listMembers).map((member) => member.name)).toContain("Ana");
    }).pipe(Effect.provide(TeamTestLayer)),
  );

  it.effect("removing a member revokes their sessions and unused invites", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;

      const used = yield* team.invite({ name: "Luis", role: "member" });
      const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
        used.credential.credential,
        undefined,
        requestMetadata,
      );

      expect(yield* team.revokeMember(used.member.memberId)).toBe(true);

      const subject = teamMemberSubject(used.member.memberId);
      expect((yield* auth.listSessions()).some((entry) => entry.subject === subject)).toBe(false);
      const rejected = yield* Effect.flip(
        auth.authenticateHttpRequest(bearer(exchanged.access_token)),
      );
      expect(rejected).toBeDefined();
      const links = yield* auth.listPairingLinks();
      expect(links.some((link) => link.subject === teamMemberSubject(used.member.memberId))).toBe(
        false,
      );
      expect(
        (yield* team.listMembers).some((member) => member.memberId === used.member.memberId),
      ).toBe(false);
    }).pipe(Effect.provide(TeamTestLayer)),
  );

  it.effect("refuses to remove the owner", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const error = yield* Effect.flip(team.revokeMember(TEAM_OWNER_MEMBER_ID));
      expect(error.message).toContain("owner");
    }).pipe(Effect.provide(TeamTestLayer)),
  );

  it.effect("reports who is connected and which thread they are viewing", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const invited = yield* team.invite({ name: "Ana", role: "member" });
      const subject = teamMemberSubject(invited.member.memberId);
      const threadId = ThreadId.make("thread-1");

      yield* team.connect({ connectionId: "c1", subject });
      yield* team.connect({ connectionId: "c2", subject: "desktop-bootstrap" });
      yield* team.setViewing("c1", threadId);

      const snapshot = yield* team
        .subscribe(subject)
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(snapshot.selfMemberId).toBe(invited.member.memberId);
      expect(snapshot.presence).toEqual(
        expect.arrayContaining([
          { memberId: invited.member.memberId, connections: 1, viewingThreadIds: [threadId] },
          { memberId: TEAM_OWNER_MEMBER_ID, connections: 1, viewingThreadIds: [] },
        ]),
      );

      yield* team.disconnect("c1");
      const after = yield* team
        .subscribe(subject)
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(after.presence.map((entry) => entry.memberId)).toEqual([TEAM_OWNER_MEMBER_ID]);
    }).pipe(Effect.provide(TeamTestLayer)),
  );
});
