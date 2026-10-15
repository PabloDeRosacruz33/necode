import {
  INTEGRATION_BRANCH_NAME,
  resolveIntegrationBranch,
} from "@t3tools/client-runtime/task-flow";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { configuredIntegrationBranch } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { StackActions } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { useMemo } from "react";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { setComposerDraftText } from "../../../state/use-composer-drafts";
import { projectEnvironment } from "../../../state/projects";
import { useEnvironmentQuery } from "../../../state/query";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { vcsEnvironment } from "../../../state/vcs";

/**
 * The selected thread's integration branch, resolved like the web branch menu and the server:
 * t3.json, then the project setting, then `staging` when the repository has it, then its
 * default branch.
 */
export function useSelectedThreadIntegrationBranch(cwd: string | null): string | null {
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const environmentId = selectedThread?.environmentId ?? null;
  const projectCwd = selectedThreadProject?.workspaceRoot ?? null;
  const projectFile = useEnvironmentQuery(
    environmentId !== null && projectCwd !== null
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd: projectCwd, relativePath: "t3.json" },
        })
      : null,
  );
  const configured = configuredIntegrationBranch(
    selectedEnvironmentRuntime?.serverConfig?.settings ?? null,
    selectedThreadProject?.id ?? null,
    projectFile.data && !projectFile.data.truncated
      ? parseT3ProjectFile(projectFile.data.contents)
      : null,
    selectedThreadProject,
  );
  const integrationRefs = useEnvironmentQuery(
    environmentId !== null && cwd !== null && !configured
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: INTEGRATION_BRANCH_NAME, limit: 10 },
        })
      : null,
  );
  return useMemo(
    () =>
      resolveIntegrationBranch(
        [...(integrationRefs.data?.refs ?? []), ...gitState.selectedThreadBranches],
        configured,
      ),
    [configured, gitState.selectedThreadBranches, integrationRefs.data?.refs],
  );
}

/** Puts a request for the agent in the thread's composer and returns to the thread. */
export function askThreadAgent(
  navigation: { readonly dispatch: (action: ReturnType<typeof StackActions.popTo>) => void },
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  prompt: string,
): void {
  setComposerDraftText(scopedThreadKey(thread.environmentId, thread.threadId), prompt);
  navigation.dispatch(
    StackActions.popTo("Thread", {
      environmentId: String(thread.environmentId),
      threadId: String(thread.threadId),
    }),
  );
}

export function commandFailureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message ? error.message : "Algo ha fallado.";
}
