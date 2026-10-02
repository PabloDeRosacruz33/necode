import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

/**
 * The resume cursor for a thread duplicated from another: the same provider conversation, marked
 * so the adapter forks it into a new one on first start instead of resuming (and writing into)
 * the original. Null for providers that cannot fork a conversation.
 */
export function forkResumeCursor(
  provider: ProviderDriverKind,
  cursor: unknown,
  threadId: ThreadId,
): Record<string, unknown> | null {
  if (!cursor || typeof cursor !== "object") return null;
  const source = cursor as Record<string, unknown>;
  if (provider === "codex" && typeof source.threadId === "string") {
    return { threadId: source.threadId, fork: true };
  }
  const resume = typeof source.resume === "string" ? source.resume : source.sessionId;
  if (provider === "claudeAgent" && typeof resume === "string") {
    return {
      threadId,
      resume,
      ...(typeof source.resumeSessionAt === "string"
        ? { resumeSessionAt: source.resumeSessionAt }
        : {}),
      forkSession: true,
    };
  }
  return null;
}
