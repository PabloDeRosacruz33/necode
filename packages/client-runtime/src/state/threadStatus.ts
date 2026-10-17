/**
 * What a thread row says about its thread, shared by the web sidebar and the mobile list so a
 * thread reads the same on every device: whether it is working, waiting on the user, or has
 * finished something the user has not looked at yet.
 */
import * as DateTime from "effect/DateTime";

export type ThreadActivityStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

interface ThreadRuntimeLike {
  readonly status: string;
  readonly lastErrorClass?: string | null | undefined;
}

interface ActivityInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: string | null | undefined;
  readonly runtime: ThreadRuntimeLike | null;
}

const ACTIVE_RUNTIME_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function resolveThreadActivityStatus(thread: ActivityInput): ThreadActivityStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if (thread.runtime !== null && ACTIVE_RUNTIME_STATUSES.has(thread.runtime.status)) {
    return "working";
  }
  if (thread.runtime?.status === "idle") return "waiting";
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

interface LatestRunTiming {
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
}

/** A plan the agent wrote is waiting for the user to approve it. */
export function isPlanReady(thread: {
  readonly hasPendingUserInput: boolean;
  readonly interactionMode: string;
  readonly latestRun: LatestRunTiming | null | undefined;
  readonly runtime: ThreadRuntimeLike | null;
  readonly hasActionableProposedPlan: boolean;
}): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    Boolean(thread.latestRun?.startedAt && thread.latestRun.completedAt) &&
    thread.runtime?.status !== "running" &&
    thread.hasActionableProposedPlan
  );
}

/**
 * The latest run finished after the user last opened the thread. A thread with no recorded
 * visit counts as read, so old threads do not all light up when a device first gets this.
 */
export function hasUnseenCompletion(thread: {
  readonly latestRun: Pick<LatestRunTiming, "completedAt"> | null | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
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
  latestRunCompletedAt: string | null | undefined,
): T {
  const completedAtMs = Date.parse(latestRunCompletedAt ?? "");
  if (!Number.isFinite(completedAtMs)) return visits;
  const unreadVisitedAt = DateTime.formatIso(DateTime.makeUnsafe(completedAtMs - 1));
  if (visits[threadKey] === unreadVisitedAt) return visits;
  return { ...visits, [threadKey]: unreadVisitedAt };
}
