/**
 * What a thread row says about its thread, shared by the web sidebar and the mobile list so a
 * thread reads the same on every device: whether it is working, waiting on the user, or has
 * finished something the user has not looked at yet.
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadActivityStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

type ActivityInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

export function resolveThreadActivityStatus(thread: ActivityInput): ThreadActivityStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must see the failure,
  // not a stale Working.
  if (thread.session?.status === "error") return "failed";
  // Background work outlives the turn: fleets read as working; monitoring only when watch
  // loops are the sole live work.
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return "ready";
}

type LatestTurnTiming = Pick<
  NonNullable<OrchestrationThreadShell["latestTurn"]>,
  "startedAt" | "completedAt"
>;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null | undefined,
  session: Pick<NonNullable<OrchestrationThreadShell["session"]>, "status"> | null | undefined,
): boolean {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) return false;
  return session?.status !== "running";
}

/** A plan the agent wrote is waiting for the user to approve it. */
export function isPlanReady(
  thread: Pick<
    OrchestrationThreadShell,
    | "hasPendingUserInput"
    | "interactionMode"
    | "latestTurn"
    | "session"
    | "hasActionableProposedPlan"
  >,
): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  );
}

/**
 * The latest turn finished after the user last opened the thread on this device. A thread the
 * device never recorded a visit for counts as read, so old threads do not all light up when a
 * device first gets this.
 */
export function hasUnseenCompletion(thread: {
  readonly latestTurn:
    | Pick<NonNullable<OrchestrationThreadShell["latestTurn"]>, "completedAt">
    | null
    | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/**
 * Records a visit, never moving a thread's marker backwards: a visit is stamped at the
 * completion the user saw, so a completion landing later still shows as new. Returns the same
 * map when nothing changes.
 */
export function markThreadVisited<T extends Readonly<Record<string, string>>>(
  visits: T,
  threadKey: string,
  visitedAt: string,
): T {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) return visits;
  const previousMs = Date.parse(visits[threadKey] ?? "");
  if (Number.isFinite(previousMs) && previousMs >= visitedAtMs) return visits;
  return { ...visits, [threadKey]: visitedAt };
}

/** Puts the marker just before the latest completion, so the thread shows as unread again. */
export function markThreadUnread<T extends Readonly<Record<string, string>>>(
  visits: T,
  threadKey: string,
  latestTurnCompletedAt: string | null | undefined,
): T {
  const completedAtMs = Date.parse(latestTurnCompletedAt ?? "");
  if (!Number.isFinite(completedAtMs)) return visits;
  const unreadVisitedAt = DateTime.formatIso(DateTime.makeUnsafe(completedAtMs - 1));
  if (visits[threadKey] === unreadVisitedAt) return visits;
  return { ...visits, [threadKey]: unreadVisitedAt };
}
