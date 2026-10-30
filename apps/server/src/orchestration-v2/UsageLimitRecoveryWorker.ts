import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAccountFailover from "./ProviderAccountFailover.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Necode: continues a thread its account's usage limit stopped on another account of the same
 * provider, with the same model. The message doubles as the note in the thread.
 */
export function limitFailoverCommand(
  limited: ProjectionStore.ProjectionUsageLimitedRun,
  route: ProviderAccountFailover.FailoverRoute,
): OrchestrationV2Command {
  const from = ProviderAccountFailover.providerLabel(route.from);
  const to = ProviderAccountFailover.providerLabel(route.to);
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-failover:${limited.runId}`),
    messageId: MessageId.make(`limit-failover:${limited.runId}`),
    threadId: limited.threadId,
    manualContinuationOfRunId: limited.runId,
    modelSelection: route.selection,
    text: `Necode: la cuenta «${from}» ha llegado a su límite, así que este hilo sigue con «${to}» y el mismo modelo. Continue where you left off.`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const failover = yield* Effect.serviceOption(ProviderAccountFailover.ProviderAccountFailover);
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    if (failover._tag === "Some") {
      const limitedRuns = yield* projections.getUsageLimitedRuns({ now });
      for (const limited of limitedRuns) {
        yield* failover.value.reportLimit(limited.modelSelection.instanceId, limited.resetAt);
      }
      for (const limited of limitedRuns) {
        const route = yield* failover.value.route({
          selection: limited.modelSelection,
          projectId: limited.projectId,
        });
        if (route === null) continue;
        yield* threads.dispatch(limitFailoverCommand(limited, route)).pipe(
          // Messages held behind the limit go on after the continuation.
          Effect.andThen(
            threads.dispatch({
              type: "queue.resume",
              commandId: CommandId.make(`limit-failover-queue:${limited.runId}`),
              threadId: limited.threadId,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
              threadId: limited.threadId,
              cause,
            }),
          ),
        );
      }
    }
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
