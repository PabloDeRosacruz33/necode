import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

/**
 * "Seguir en una tarea nueva": the same thread, with its whole conversation, moves to a new branch
 * and folder from the latest integration branch. The task it leaves is closed first.
 */
export function ContinueTaskDialog({
  open,
  onOpenChange,
  environmentId,
  threadId,
  projectCwd,
  previous,
  targetRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectCwd: string;
  /** The task this thread works in now, closed on the way; null for the shared checkout. */
  previous: { readonly worktreePath: string; readonly branch: string } | null;
  targetRef: string;
}) {
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branchPrefix = useClientSettings((settings) => settings.taskBranchPrefix);
  const continueTask = useAtomCommand(vcsEnvironment.continueTask, { reportFailure: false });

  const start = async () => {
    const taskName = name.trim();
    if (!taskName || running) return;
    setRunning(true);
    setError(null);
    const result = await continueTask({
      environmentId,
      input: {
        threadId,
        projectCwd,
        previous,
        targetRef,
        taskName,
        ...(branchPrefix.trim() ? { branchPrefix: branchPrefix.trim() } : {}),
      },
    });
    setRunning(false);
    if (result._tag === "Failure") {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error && failure.message ? failure.message : "Algo ha fallado.");
      return;
    }
    setName("");
    onOpenChange(false);
    toastManager.add({
      type: "success",
      title: "Tarea nueva lista",
      description: `Este hilo sigue en ${result.value.branch}, con toda la conversación.`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Seguir en una tarea nueva</DialogTitle>
          <DialogDescription>
            {previous
              ? `Se cierra la tarea actual (${previous.branch}) y este hilo sigue en una rama nueva desde lo último de ${targetRef}. La conversación se conserva.`
              : `Este hilo sigue en una rama nueva desde lo último de ${targetRef}, con su propia carpeta. La conversación se conserva.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            size="sm"
            autoFocus
            placeholder="arreglar-sidebar"
            aria-label="Nombre de la tarea nueva"
            value={name}
            disabled={running}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void start();
              }
            }}
          />
          {running ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Preparando la tarea nueva…
            </p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button size="sm" disabled={!name.trim() || running} onClick={() => void start()}>
            Seguir en la tarea nueva
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
