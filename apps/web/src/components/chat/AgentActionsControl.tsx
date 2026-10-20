/**
 * Necode: the project's t3.json `agentActions` as header buttons. Each starts a new thread in the
 * project's main folder whose first message is the action's prompt (e.g. Ultra Deploy).
 */
import { buildAgentActionTurn } from "@t3tools/client-runtime/operations";
import type { EnvironmentId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import { RocketIcon } from "lucide-react";
import { useState } from "react";

import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
import { randomUUID } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

export function AgentActionsControl({
  environmentId,
  projectId,
  projectCwd,
  modelSelection,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectCwd: string;
  modelSelection: ModelSelection | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const projectFile = useT3ProjectFileState(environmentId, projectCwd);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [running, setRunning] = useState<string | null>(null);
  const actions = projectFile.file?.agentActions ?? [];
  if (actions.length === 0 || modelSelection === null) return null;

  return actions.map((action) => (
    <Button
      key={action.name}
      size="xs"
      variant="outline"
      disabled={running !== null}
      title={action.prompt}
      onClick={async () => {
        setRunning(action.name);
        const threadId = randomUUID();
        const result = await startTurn({
          environmentId,
          input: buildAgentActionTurn({
            action,
            projectId,
            modelSelection,
            threadId,
            commandId: randomUUID(),
            messageId: randomUUID(),
            createdAt: new Date().toISOString(),
            creationSource: "web",
          }),
        });
        setRunning(null);
        if (result._tag === "Success") {
          onOpenThread(threadId as ThreadId);
        } else {
          toastManager.add({ type: "error", title: `No se pudo empezar ${action.name}` });
        }
      }}
    >
      {running === action.name ? (
        <Spinner className="size-3.5" />
      ) : (
        <RocketIcon aria-hidden="true" className="size-3.5" />
      )}
      <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
        {action.name}
      </span>
    </Button>
  ));
}
