/**
 * Necode: what a command an agent left running in the background is printing (a build, a deploy),
 * refreshed while the dialog is open.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const REFRESH_MS = 2000;

export function BackgroundTaskOutputDialog({
  environmentId,
  threadId,
  task,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  task: { readonly taskId: string; readonly label: string } | null;
  onClose: () => void;
}) {
  const output = useEnvironmentQuery(
    task === null
      ? null
      : vcsEnvironment.backgroundTaskOutput({
          environmentId,
          input: { threadId, taskId: task.taskId },
        }),
  );
  const refresh = output.refresh;
  useEffect(() => {
    if (task === null) return;
    const interval = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(interval);
  }, [task, refresh]);
  const logRef = useRef<HTMLPreElement>(null);
  const text = output.data?.output ?? null;
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [text]);

  return (
    <Dialog open={task !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>En segundo plano</DialogTitle>
          <DialogDescription>{task?.label ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {output.data && text === null ? (
            <p className="text-sm text-muted-foreground">
              Este agente no guarda la salida de sus comandos en segundo plano.
            </p>
          ) : (
            <pre
              ref={logRef}
              className="max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
            >
              {output.data?.truncated ? "…\n" : ""}
              {text === "" ? "(todavía no ha escrito nada)" : (text ?? "")}
            </pre>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
