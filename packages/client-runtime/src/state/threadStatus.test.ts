import { describe, expect, it } from "vite-plus/test";

import {
  hasUnseenCompletion,
  isPlanReady,
  markThreadUnread,
  markThreadVisited,
  resolveThreadActivityStatus,
} from "./threadStatus.ts";

const turn = { startedAt: "2026-03-09T10:00:00.000Z", completedAt: "2026-03-09T10:05:00.000Z" };

describe("resolveThreadActivityStatus", () => {
  const base = { hasPendingApprovals: false, hasPendingUserInput: false, session: null };
  it("ranks the user's turn above the agent's work, and a failure above background work", () => {
    expect(
      resolveThreadActivityStatus({
        ...base,
        hasPendingApprovals: true,
        session: { status: "running" } as never,
      }),
    ).toBe("approval");
    expect(
      resolveThreadActivityStatus({
        ...base,
        session: { status: "error" } as never,
        backgroundLiveness: "working",
      }),
    ).toBe("failed");
    expect(resolveThreadActivityStatus({ ...base, backgroundLiveness: "monitoring" })).toBe(
      "monitoring",
    );
    expect(resolveThreadActivityStatus(base)).toBe("ready");
  });
});

describe("hasUnseenCompletion", () => {
  it("is true only for a completion after this device's last visit", () => {
    expect(
      hasUnseenCompletion({ latestTurn: turn, lastVisitedAt: "2026-03-09T10:04:00.000Z" }),
    ).toBe(true);
    expect(
      hasUnseenCompletion({ latestTurn: turn, lastVisitedAt: "2026-03-09T10:05:00.000Z" }),
    ).toBe(false);
    expect(hasUnseenCompletion({ latestTurn: turn, lastVisitedAt: undefined })).toBe(false);
    expect(
      hasUnseenCompletion({ latestTurn: null, lastVisitedAt: "2026-03-09T10:04:00.000Z" }),
    ).toBe(false);
  });
});

describe("visit markers", () => {
  it("never move backwards, and marking unread lands just before the completion", () => {
    const visited = markThreadVisited<Record<string, string>>({}, "t", turn.completedAt);
    expect(visited).toEqual({ t: turn.completedAt });
    expect(markThreadVisited(visited, "t", "2026-03-09T10:04:00.000Z")).toBe(visited);
    const unread = markThreadUnread(visited, "t", turn.completedAt);
    expect(hasUnseenCompletion({ latestTurn: turn, lastVisitedAt: unread.t })).toBe(true);
    expect(markThreadUnread(unread, "t", turn.completedAt)).toBe(unread);
    expect(markThreadUnread(visited, "t", null)).toBe(visited);
  });
});

describe("isPlanReady", () => {
  it("needs a settled plan-mode turn with a plan to act on", () => {
    const thread = {
      hasPendingUserInput: false,
      interactionMode: "plan" as const,
      latestTurn: turn as never,
      session: null,
      hasActionableProposedPlan: true,
    };
    expect(isPlanReady(thread)).toBe(true);
    expect(isPlanReady({ ...thread, session: { status: "running" } as never })).toBe(false);
    expect(isPlanReady({ ...thread, interactionMode: "default" })).toBe(false);
  });
});
