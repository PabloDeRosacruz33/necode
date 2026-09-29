import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildThreadHandoffPrompt,
  resolveThreadHandoffTargets,
  type ThreadHandoffTarget,
} from "../lib/threadHandoff";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThread, readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { useNewThreadHandler } from "./useHandleNewThread";

const readProviders = (threadRef: ScopedThreadRef) =>
  appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId)?.providers ?? [];

/**
 * "Continue with…": opens a draft on the same project and checkout with
 * another provider selected and a handoff of the conversation in the composer.
 * Nothing is sent until the user reviews it.
 */
export function useContinueThreadWith() {
  const handleNewThread = useNewThreadHandler();

  const targetsFor = useCallback(
    (threadRef: ScopedThreadRef): ReadonlyArray<ThreadHandoffTarget> =>
      resolveThreadHandoffTargets(
        readProviders(threadRef),
        readThreadShell(threadRef)?.modelSelection.instanceId ?? null,
      ),
    [],
  );

  const continueWith = useCallback(
    async (threadRef: ScopedThreadRef, instanceId: string) => {
      const target = targetsFor(threadRef).find(
        (candidate) => candidate.modelSelection.instanceId === instanceId,
      );
      const thread = readThread(threadRef);
      if (!target || !thread) return;
      if (thread.messages.length === 0) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Open the thread first",
            description: "Its conversation has not loaded yet, so there is nothing to hand off.",
          }),
        );
        return;
      }
      const sourceInstanceId = thread.modelSelection.instanceId;
      const sourceLabel =
        readProviders(threadRef).find((provider) => provider.instanceId === sourceInstanceId)
          ?.displayName ?? sourceInstanceId;
      const created = await settlePromise(() =>
        handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          envMode: thread.worktreePath ? "worktree" : "local",
          startFromOrigin: false,
        }),
      );
      if (created._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create thread",
            description: String(squashAtomCommandFailure(created)),
          }),
        );
        return;
      }
      if (created.value === null) return;
      const store = useComposerDraftStore.getState();
      store.setModelSelection(created.value.draftId, target.modelSelection, {
        explicit: true,
        replaceOptions: true,
      });
      store.setPrompt(
        created.value.draftId,
        buildThreadHandoffPrompt({
          title: thread.title,
          sourceLabel,
          messages: thread.messages,
        }),
      );
    },
    [handleNewThread, targetsFor],
  );

  return { targetsFor, continueWith };
}
