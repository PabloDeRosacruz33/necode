import {
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationMessage,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * "Continue with…" moves a conversation to another provider. Providers keep
 * their own session memory, so the new thread starts from a written handoff:
 * a transcript digest the user reviews in the composer before sending.
 */
export interface ThreadHandoffTarget {
  readonly label: string;
  readonly modelSelection: ModelSelection;
}

/** Providers a started thread can hand off to: ready, and not the one it already uses. */
export function resolveThreadHandoffTargets(
  providers: ReadonlyArray<ServerProvider>,
  currentInstanceId: string | null,
): ReadonlyArray<ThreadHandoffTarget> {
  return providers.flatMap((provider) => {
    if (provider.instanceId === currentInstanceId) return [];
    if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) return [];
    const model =
      provider.models.find((candidate) => candidate.isDefault) ??
      provider.models.find((candidate) => !candidate.isLegacy) ??
      provider.models[0];
    if (!model) return [];
    return [
      {
        label: provider.displayName ?? provider.instanceId,
        modelSelection: { instanceId: provider.instanceId, model: model.slug } as ModelSelection,
      },
    ];
  });
}

const MAX_MESSAGE_CHARS = 1_500;
const MAX_TRANSCRIPT_CHARS = 14_000;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n[…]`;
}

/**
 * The first message of the new thread. Keeps the most recent exchanges that
 * fit, oldest first, and asks the new agent to check the workspace itself
 * because earlier tool output is not carried over.
 */
export function buildThreadHandoffPrompt(input: {
  readonly title: string;
  readonly sourceLabel: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}): string {
  const turns = input.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.text.trim().length > 0,
    )
    .map(
      (message) =>
        `${message.role === "user" ? "User" : input.sourceLabel}:\n${clip(message.text, MAX_MESSAGE_CHARS)}`,
    );

  const kept: string[] = [];
  let used = 0;
  for (const turn of turns.toReversed()) {
    if (used + turn.length > MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(turn);
    used += turn.length;
  }
  const omitted = turns.length - kept.length;

  return [
    `You are taking over a conversation that started with ${input.sourceLabel} in the thread "${input.title}".`,
    "Here is the transcript so far" +
      (omitted > 0 ? ` (the ${omitted} oldest messages are omitted):` : ":"),
    "",
    kept.length > 0 ? kept.join("\n\n") : "(No messages yet.)",
    "",
    "Tool calls and their output are not included. Inspect the workspace (for example git status and the recent diff) before changing anything, then continue from where the conversation left off.",
    "",
    "Next request: ",
  ].join("\n");
}
