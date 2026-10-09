import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  type OrchestrationThreadShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { type SettlementPullRequest, resolveAutoSettlementAt } from "./ThreadSettlementPolicy.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: "feature",
  worktreePath: "/repo",
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const decide = (
  thread: OrchestrationThreadShell,
  pullRequest: SettlementPullRequest | null = null,
  settings: { merge?: boolean } = {},
) =>
  resolveAutoSettlementAt({
    thread,
    pullRequest,
    now: NOW,
    autoSettleOnMerge: settings.merge ?? true,
  }) !== null;

const MERGED: SettlementPullRequest = { state: "merged", mergedAt: "2026-08-21T00:00:00.000Z" };

describe("resolveAutoSettlementAt", () => {
  it("returns the last activity time for persisted settlement", () => {
    expect(
      resolveAutoSettlementAt({
        thread: makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-terminal"),
            state: "completed",
            requestedAt: "2026-08-19T00:00:00.000Z",
            startedAt: "2026-08-19T00:01:00.000Z",
            completedAt: "2026-08-21T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
        pullRequest: { state: "merged", mergedAt: "2026-08-21T12:00:00.000Z" },
        now: NOW,
        autoSettleOnMerge: true,
      }),
    ).toBe("2026-08-21T00:00:00.000Z");
  });

  it("uses creation time for PR settlement when the thread has no activity", () => {
    expect(
      resolveAutoSettlementAt({
        thread: makeThread({
          latestUserMessageAt: null,
          latestTurn: null,
          updatedAt: "2026-08-27T00:00:00.000Z",
        }),
        pullRequest: { state: "closed", closedAt: NOW },
        now: NOW,
        autoSettleOnMerge: true,
      }),
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  it("never settles a thread for being idle", () => {
    const idle = makeThread({ latestUserMessageAt: "2026-01-01T00:00:00.000Z" });
    expect(decide(idle)).toBe(false);
    expect(decide(idle, { state: "open", updatedAt: NOW })).toBe(false);
  });

  it("settles closed requests and honors the merge setting", () => {
    expect(decide(makeThread(), { state: "closed", closedAt: NOW }, { merge: false })).toBe(true);
    expect(decide(makeThread(), { state: "merged", mergedAt: NOW })).toBe(true);
    expect(decide(makeThread(), { state: "merged", mergedAt: NOW }, { merge: false })).toBe(false);
  });

  it("does not settle again after user activity newer than the PR", () => {
    expect(
      decide(makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }), {
        state: "merged",
        mergedAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it.each(["closed", "merged"] as const)(
    "ignores metadata edits after resumed work for %s requests",
    (state) => {
      expect(
        decide(makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }), {
          state,
          closedAt: "2026-08-26T00:00:00.000Z",
          mergedAt: "2026-08-26T00:00:00.000Z",
          updatedAt: NOW,
        }),
      ).toBe(false);
      expect(decide(makeThread(), { state, updatedAt: NOW })).toBe(false);
    },
  );

  it("does not inherit a terminal pull request older than the thread", () => {
    expect(
      decide(makeThread({ createdAt: "2026-08-20T00:00:00.000Z", latestUserMessageAt: null }), {
        state: "closed",
        closedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("requires a comparable PR timestamp for immediate settlement", () => {
    const recentThread = makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" });
    expect(decide(recentThread, { state: "closed", closedAt: null })).toBe(false);
    expect(decide(recentThread, { state: "merged", mergedAt: "unknown" })).toBe(false);
  });

  it("uses user request time instead of completion time as the PR anchor", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-25T00:00:00.000Z",
        startedAt: "2026-08-25T00:01:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(decide(thread, { state: "merged", mergedAt: "2026-08-26T00:00:00.000Z" })).toBe(true);
  });

  it("blocks pins, snooze, pending work, live sessions, and queued starts", () => {
    expect(decide(makeThread(), MERGED)).toBe(true);
    expect(decide(makeThread({ settledOverride: "active" }), MERGED)).toBe(false);
    expect(decide(makeThread({ pinnedAt: "2026-08-01T00:00:00.000Z" }), MERGED)).toBe(false);
  });

  it("never settles a thread whose auto-settle is turned off, or is busy", () => {
    const held = makeThread({ autoSettleDisabledAt: "2026-08-21T00:00:00.000Z" });
    expect(decide(held, MERGED)).toBe(false);
    expect(decide(makeThread({ autoSettleDisabledAt: null }), MERGED)).toBe(true);
    expect(decide(makeThread({ snoozedUntil: "2026-08-29T00:00:00.000Z" }), MERGED)).toBe(false);
    expect(decide(makeThread({ hasPendingApprovals: true }), MERGED)).toBe(false);
    expect(decide(makeThread({ hasPendingUserInput: true }), MERGED)).toBe(false);
    expect(decide(makeThread({ backgroundLiveness: "working" }), MERGED)).toBe(false);
    expect(decide(makeThread({ backgroundLiveness: "monitoring" }), MERGED)).toBe(false);
    expect(
      decide(
        makeThread({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: NOW,
          },
        }),
        MERGED,
      ),
    ).toBe(false);
    expect(
      decide(makeThread({ latestUserMessageAt: "2026-08-28T11:59:00.000Z", latestTurn: null }), {
        state: "merged",
        mergedAt: NOW,
      }),
    ).toBe(false);
  });

  it("allows a fresh completion to wake snooze before settlement", () => {
    expect(
      decide(
        makeThread({
          snoozedAt: "2026-08-19T00:00:00.000Z",
          snoozedUntil: "2026-08-29T00:00:00.000Z",
          latestTurn: {
            turnId: TurnId.make("turn-woke"),
            state: "completed",
            requestedAt: "2026-08-18T00:00:00.000Z",
            startedAt: "2026-08-18T00:01:00.000Z",
            completedAt: "2026-08-20T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
        MERGED,
      ),
    ).toBe(true);
  });
});

function linkedRequest(
  number: number,
  snapshot: ThreadPullRequestLink["snapshot"],
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "org/repo",
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    source: "manual",
    linkedAt: NOW,
    stack: null,
    snapshot,
  };
}

const terminalSnapshot = (
  state: "closed" | "merged",
  terminalAt: string,
  updatedAt = terminalAt,
) => ({
  state,
  title: "Change",
  headBranch: "feature",
  baseBranch: "main",
  isDraft: false,
  closedAt: terminalAt,
  mergedAt: state === "merged" ? terminalAt : null,
  updatedAt,
  syncedAt: NOW,
});

describe("per-thread auto-settle opt out", () => {
  it("blocks merge settlement while auto-settle is off", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    expect(decide(makeThread({ pullRequests: [merged] }))).toBe(true);
    expect(decide(makeThread({ autoSettleDisabledAt: NOW, pullRequests: [merged] }))).toBe(false);
  });
});

describe("linked request settlement", () => {
  it.each(["closed", "merged"] as const)(
    "uses the latest actual %s transition despite later comments on another PR",
    (state) => {
      const old = linkedRequest(1, terminalSnapshot(state, "2026-08-19T00:00:00.000Z", NOW));
      const recent = linkedRequest(2, terminalSnapshot(state, "2026-08-21T00:00:00.000Z"));
      expect(decide(makeThread({ pullRequests: [old, recent] }), null)).toBe(true);
      expect(decide(makeThread({ pullRequests: [recent, old] }), null)).toBe(true);
      expect(decide(makeThread({ pullRequests: [old] }), null)).toBe(false);
    },
  );

  it("keeps unknown and open links active", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    const unknown = linkedRequest(2, null);
    const open = linkedRequest(3, {
      ...terminalSnapshot("closed", NOW),
      state: "open",
      closedAt: null,
    });
    expect(decide(makeThread({ pullRequests: [merged, unknown] }))).toBe(false);
    expect(decide(makeThread({ pullRequests: [merged, open] }))).toBe(false);
    expect(
      decide(makeThread({ pullRequests: [merged, { ...unknown, source: "stack-dismissed" }] })),
    ).toBe(true);
  });

  it("honors merge settings and ignores missing terminal timestamps", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    expect(decide(makeThread({ pullRequests: [merged] }), null, { merge: false })).toBe(false);
    const missing = linkedRequest(2, { ...terminalSnapshot("merged", NOW), mergedAt: null });
    expect(decide(makeThread({ pullRequests: [missing] }), null)).toBe(false);
    expect(decide(makeThread({ pullRequests: [missing, merged] }), null)).toBe(true);
  });
});
