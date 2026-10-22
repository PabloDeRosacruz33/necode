import { describe, expect, it } from "vite-plus/test";

import {
  countRunningBackgroundCommands,
  hasUnseenCompletion,
  isPlanReady,
  markThreadUnread,
  markThreadVisited,
  resolveThreadActivityStatus,
} from "./threadStatus.ts";

const turn = { startedAt: "2026-03-09T10:00:00.000Z", completedAt: "2026-03-09T10:05:00.000Z" };

describe("resolveThreadActivityStatus", () => {
  const base = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };
  it("ranks the user's turn above the agent's work and tells a usage limit from a failure", () => {
    expect(
      resolveThreadActivityStatus({
        ...base,
        hasPendingApprovals: true,
        runtime: { status: "running" },
      }),
    ).toBe("approval");
    expect(resolveThreadActivityStatus({ ...base, runtime: { status: "running" } })).toBe(
      "working",
    );
    expect(resolveThreadActivityStatus({ ...base, runtime: { status: "idle" } })).toBe("waiting");
    expect(
      resolveThreadActivityStatus({
        ...base,
        runtime: { status: "failed", lastErrorClass: "usage_limit" },
      }),
    ).toBe("limited");
    expect(resolveThreadActivityStatus(base)).toBe("ready");
  });
});

describe("hasUnseenCompletion", () => {
  it("is true only for a completion after this device's last visit", () => {
    expect(
      hasUnseenCompletion({ latestRun: turn, lastVisitedAt: "2026-03-09T10:04:00.000Z" }),
    ).toBe(true);
    expect(
      hasUnseenCompletion({ latestRun: turn, lastVisitedAt: "2026-03-09T10:05:00.000Z" }),
    ).toBe(false);
    expect(hasUnseenCompletion({ latestRun: turn, lastVisitedAt: undefined })).toBe(false);
    expect(
      hasUnseenCompletion({ latestRun: null, lastVisitedAt: "2026-03-09T10:04:00.000Z" }),
    ).toBe(false);
  });
});

describe("visit markers", () => {
  it("never move backwards, and marking unread lands just before the completion", () => {
    const visited = markThreadVisited<Record<string, string>>({}, "t", turn.completedAt);
    expect(visited).toEqual({ t: turn.completedAt });
    expect(markThreadVisited(visited, "t", "2026-03-09T10:04:00.000Z")).toBe(visited);
    const unread = markThreadUnread(visited, "t", turn.completedAt);
    expect(hasUnseenCompletion({ latestRun: turn, lastVisitedAt: unread.t })).toBe(true);
    expect(markThreadUnread(unread, "t", turn.completedAt)).toBe(unread);
    expect(markThreadUnread(visited, "t", null)).toBe(visited);
  });
});

describe("isPlanReady", () => {
  it("needs a settled plan-mode turn with a plan to act on", () => {
    const thread = {
      hasPendingUserInput: false,
      interactionMode: "plan" as const,
      latestRun: turn,
      runtime: null,
      hasActionableProposedPlan: true,
    };
    expect(isPlanReady(thread)).toBe(true);
    expect(isPlanReady({ ...thread, runtime: { status: "running" } })).toBe(false);
    expect(isPlanReady({ ...thread, interactionMode: "default" })).toBe(false);
  });
});

describe("countRunningBackgroundCommands", () => {
  it("counts the commands an agent left running, not subagents or monitors", () => {
    expect(
      countRunningBackgroundCommands([
        { kind: "command" },
        { kind: "subagent" },
        { kind: "monitor" },
        { kind: "command" },
      ]),
    ).toBe(2);
    expect(countRunningBackgroundCommands(undefined)).toBe(0);
  });
});
