import { ThreadId, type TeamMember, type TeamSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  onlineTeamMembers,
  shouldLabelMessageAuthor,
  teamMemberInitials,
  teamMembersViewingThread,
} from "./team.ts";

const member = (memberId: string, name: string): TeamMember => ({
  memberId,
  name,
  color: "#000000",
  role: memberId === "owner" ? "owner" : "member",
  createdAt: DateTime.makeUnsafe("2026-09-29T10:00:00.000Z"),
});

const thread = ThreadId.make("thread-1");

const snapshot: TeamSnapshot = {
  members: [member("owner", "Pablo"), member("ana", "Ana Ruiz"), member("luis", "Luis")],
  presence: [
    { memberId: "owner", connections: 1, viewingThreadIds: [thread] },
    { memberId: "ana", connections: 2, viewingThreadIds: [thread] },
  ],
  selfMemberId: "owner",
};

describe("team helpers", () => {
  it("lists other members viewing a thread, never the viewer", () => {
    expect(teamMembersViewingThread(snapshot, thread).map((entry) => entry.memberId)).toEqual([
      "ana",
    ]);
  });

  it("lists online members with the viewer first", () => {
    expect(onlineTeamMembers({ ...snapshot, selfMemberId: "ana" }).map((m) => m.memberId)).toEqual([
      "ana",
      "owner",
    ]);
  });

  it("labels authors only for known members once there is a team", () => {
    expect(shouldLabelMessageAuthor(snapshot, "ana")).toBe(true);
    expect(shouldLabelMessageAuthor(snapshot, undefined)).toBe(false);
    expect(shouldLabelMessageAuthor(snapshot, "removed-member")).toBe(false);
    expect(
      shouldLabelMessageAuthor({ ...snapshot, members: [member("owner", "Pablo")] }, "owner"),
    ).toBe(false);
  });

  it("derives initials", () => {
    expect(teamMemberInitials("Ana Ruiz")).toBe("AR");
    expect(teamMemberInitials("luis")).toBe("LU");
  });
});
