import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { requestDuplicateThread } from "../components/git/DuplicateThreadDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { buildThreadHandoffPrompt } from "../lib/threadHandoff";
import { readThread, readThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { buildThreadRouteParams } from "../threadRoutes";
import { useClientSettings } from "./useSettings";

/**
 * "Duplicar en un hilo paralelo": asks for the new task, has the server copy the thread (history,
 * agent context, its own branch and folder) and opens the copy.
 */
export function useDuplicateThread() {
  const router = useRouter();
  const duplicate = useAtomCommand(vcsEnvironment.duplicateThread, { reportFailure: false });
  const branchPrefix = useClientSettings((settings) => settings.taskBranchPrefix);

  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const shell = readThreadShell(threadRef);
      if (!shell) return;
      const base = (shell.branch?.slice(shell.branch.lastIndexOf("/") + 1) ?? "")
        .replace(/-v\d+$/, "")
        .trim();
      const choice = await requestDuplicateThread(`${base || "tarea"}-paralelo`);
      if (!choice) return;
      const result = await duplicate({
        environmentId: threadRef.environmentId,
        input: {
          sourceThreadId: threadRef.threadId,
          taskName: choice.taskName,
          from: choice.from,
          ...(branchPrefix.trim() ? { branchPrefix: branchPrefix.trim() } : {}),
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "No se pudo duplicar el hilo",
            description: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      const copyRef = scopeThreadRef(threadRef.environmentId, result.value.threadId);
      const source = readThread(threadRef);
      if (!result.value.forked && source) {
        // This provider cannot fork its conversation; hand it a written summary instead.
        useComposerDraftStore.getState().setPrompt(
          copyRef,
          buildThreadHandoffPrompt({
            title: source.title,
            sourceLabel: "el agente",
            messages: source.messages,
          }),
        );
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(copyRef),
      });
      toastManager.add({
        type: "success",
        title: "Hilo paralelo listo",
        description: result.value.forked
          ? `Sigue en ${result.value.branch} con todo el contexto del original.`
          : `Sigue en ${result.value.branch}. Este agente no puede copiar su memoria: lleva un resumen en el mensaje.`,
      });
    },
    [branchPrefix, duplicate, router],
  );
}
