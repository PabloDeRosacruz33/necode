import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  requestDuplicateThread,
  type DuplicateThreadDestination,
} from "../components/git/DuplicateThreadDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { buildThreadHandoffPrompt, resolveThreadHandoffTargets } from "../lib/threadHandoff";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThread, readThreadShell, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { buildThreadRouteParams } from "../threadRoutes";
import { useClientSettings } from "./useSettings";

/**
 * "Duplicar en un hilo paralelo": asks where, with which agent and from where, has that
 * environment create the copy (forking the agent's conversation when it is the same agent on the
 * same machine) and opens it.
 */
export function useDuplicateThread() {
  const router = useRouter();
  const duplicate = useAtomCommand(vcsEnvironment.duplicateThread, { reportFailure: false });
  const branchPrefix = useClientSettings((settings) => settings.taskBranchPrefix);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const { environments } = useEnvironments();

  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const shell = readThreadShell(threadRef);
      const source = readThread(threadRef);
      const sourceProject = projects.find(
        (project) =>
          project.environmentId === threadRef.environmentId && project.id === shell?.projectId,
      );
      if (!shell || !sourceProject) return;

      // Every connected environment with the same repository, with the agents ready there.
      const logicalKey = deriveLogicalProjectKeyFromSettings(
        sourceProject,
        projectGroupingSettings,
      );
      const configs = appAtomRegistry.get(environmentServerConfigsAtom);
      const destinations: DuplicateThreadDestination[] = [];
      for (const project of projects) {
        if (deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings) !== logicalKey) {
          continue;
        }
        if (destinations.some((entry) => entry.environmentId === project.environmentId)) continue;
        const agents = resolveThreadHandoffTargets(
          configs.get(project.environmentId)?.providers ?? [],
          null,
        ).map((target) =>
          // The source's own agent keeps the exact model the thread uses.
          target.modelSelection.instanceId === shell.modelSelection.instanceId
            ? { label: target.label, modelSelection: shell.modelSelection }
            : target,
        );
        if (agents.length === 0) continue;
        destinations.push({
          environmentId: project.environmentId,
          projectId: project.id,
          label:
            environments.find((environment) => environment.environmentId === project.environmentId)
              ?.label ?? project.environmentId,
          agents,
        });
      }
      destinations.sort((a, b) =>
        a.environmentId === threadRef.environmentId
          ? -1
          : b.environmentId === threadRef.environmentId
            ? 1
            : a.label.localeCompare(b.label),
      );
      if (destinations.length === 0) return;

      const base = (shell.branch?.slice(shell.branch.lastIndexOf("/") + 1) ?? "")
        .replace(/-v\d+$/, "")
        .trim();
      const choice = await requestDuplicateThread({
        suggestedName: `${base || "tarea"}-paralelo`,
        destinations,
        sourceEnvironmentId: threadRef.environmentId,
        sourceInstanceId: shell.modelSelection.instanceId,
      });
      if (!choice) return;

      const sameEnvironment = choice.destination.environmentId === threadRef.environmentId;
      const messages = (source?.messages ?? []).filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          !message.streaming &&
          message.text.trim().length > 0,
      );
      if (!sameEnvironment && messages.length === 0) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Abre el hilo primero",
            description: "Su conversación aún no se ha cargado, así que no hay nada que llevar.",
          }),
        );
        return;
      }
      const result = await duplicate({
        environmentId: choice.destination.environmentId,
        input: {
          source: sameEnvironment
            ? { _tag: "local", threadId: threadRef.threadId }
            : {
                _tag: "transferred",
                projectId: choice.destination.projectId,
                title: shell.title,
                branch: shell.branch ?? null,
                messages: messages.map((message) => ({
                  role: message.role === "user" ? "user" : "assistant",
                  text: message.text,
                  createdAt: message.createdAt,
                })),
              },
          taskName: choice.taskName,
          from: choice.from,
          modelSelection: choice.modelSelection,
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
      const copyRef = scopeThreadRef(choice.destination.environmentId, result.value.threadId);
      if (!result.value.forked && source) {
        // The agent's own memory could not come along; hand it a written summary instead.
        useComposerDraftStore.getState().setPrompt(
          copyRef,
          buildThreadHandoffPrompt({
            title: source.title,
            sourceLabel:
              configs
                .get(threadRef.environmentId)
                ?.providers.find(
                  (provider) => provider.instanceId === shell.modelSelection.instanceId,
                )?.displayName ?? shell.modelSelection.instanceId,
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
          : `Sigue en ${result.value.branch}. Lleva el historial y un resumen en el mensaje.`,
      });
    },
    [branchPrefix, duplicate, environments, projectGroupingSettings, projects, router],
  );
}
