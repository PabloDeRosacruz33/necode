import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2CreationSource,
  type ProjectId,
  type T3ProjectFileAgentAction,
} from "@t3tools/contracts";

import type { StartThreadTurnInput } from "./commands.ts";

/**
 * Necode: the turn a t3.json agent action starts, a new thread in the project's main folder whose
 * first message is the action's prompt. Web and mobile both send it with `startTurn`.
 */
export function buildAgentActionTurn(input: {
  readonly action: T3ProjectFileAgentAction;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly creationSource: OrchestrationV2CreationSource;
}): StartThreadTurnInput {
  return {
    commandId: CommandId.make(input.commandId),
    creationSource: input.creationSource,
    threadId: ThreadId.make(input.threadId),
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user",
      text: input.action.prompt,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.action.name,
        modelSelection: input.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}
