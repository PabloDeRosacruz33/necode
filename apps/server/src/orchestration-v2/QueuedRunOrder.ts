import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/**
 * A message another thread sent (t3_thread_send). Nobody watches another
 * thread's queue, so a stop or a restart does not hold it for a person to
 * release: it starts once the thread is free. On 2026-10-22 a Necode update
 * held three such messages and no one ever read them.
 */
export function isThreadSentMessage(
  message: Pick<OrchestrationV2ConversationMessage, "senderThreadId" | "createdBy">,
): boolean {
  return message.senderThreadId !== undefined && message.createdBy === "agent";
}

/**
 * Whether nobody is watching for this message: another thread's, or a scheduled task's. A stop or a
 * restart must not hold a queue that has one, because no person would come to release it. On
 * 2026-11-02 a restart held a scheduled message, every later one was born held behind it, and the
 * Coordinador's queue stayed stuck for a day.
 */
export function isUnwatchedMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "senderThreadId" | "createdBy" | "scheduledTaskId"
  >,
): boolean {
  return isThreadSentMessage(message) || message.scheduledTaskId !== undefined;
}

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}
