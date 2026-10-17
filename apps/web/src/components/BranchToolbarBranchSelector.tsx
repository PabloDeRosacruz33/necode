import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useRightPanelStore } from "../rightPanelStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  GitCommandError,
  VCS_SWITCH_REF_UNCOMMITTED_CHANGES_OPERATION,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedProjectRef,
  type VcsRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  ListPlusIcon,
  MessageSquareShareIcon,
  CopyPlusIcon,
  MergeIcon,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useOptimistic,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { usePaginatedBranches } from "../state/queries";
import { useProject, useThreadShell, useThreadShellsForProjectRefs } from "../state/entities";
import { useT3ProjectFileState } from "../hooks/useT3ProjectFileScripts";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { configuredIntegrationBranch as resolveConfiguredIntegrationBranch } from "@t3tools/shared/projectSettings";
import { MergeTaskDialog } from "./git/MergeTaskDialog";
import { NewTaskDialog } from "./git/NewTaskDialog";
import { ContinueTaskDialog } from "./git/ContinueTaskDialog";
import { useDuplicateThread } from "../hooks/useDuplicateThread";
import { useEnvironmentQuery } from "../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { ThreadDetailsPrRows } from "./chat/ThreadDetailsPrRows";
import { parsePullRequestReference } from "../pullRequestReference";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  buildResolveConflictsPrompt,
  deriveLocalBranchNameFromRemoteRef,
  INTEGRATION_BRANCH_NAME,
  resolveIntegrationBranch,
  resolveBranchTriggerLabel,
  resolveBranchToolbarPrBranch,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";

import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";
import { ComposerControl } from "./chat/ComposerControl";
import { MiddleTruncate } from "./ui/middle-truncate";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { describeWorktreeSetup } from "@t3tools/client-runtime/task-flow";

export interface BranchToolbarBranchSelectorHandle {
  open: () => void;
}

interface BranchToolbarBranchSelectorProps {
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  className?: string;
  displayMode?: "toolbar" | "panel";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

const isGitCommandError = Schema.is(GitCommandError);

const NO_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = [];

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function BranchToolbarBranchSelector({
  forceNewWorktree = false,
  ref,
  className,
  displayMode = "toolbar",
  environmentId,
  threadId,
  draftId,
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const updateEmptyThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, {
    reportFailure: false,
  });
  const createRefMutation = useAtomCommand(vcsEnvironment.createRef, {
    reportFailure: false,
  });
  const mergeIntoMutation = useAtomCommand(vcsEnvironment.mergeInto, {
    reportFailure: false,
  });
  const syncWithMutation = useAtomCommand(vcsEnvironment.syncWith, {
    reportFailure: false,
  });
  const threadRef = scopeThreadRef(environmentId, threadId);
  const serverThread = useThreadShell(threadRef);
  const serverSession = serverThread?.runtime ?? null;
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setComposerPrompt = useComposerDraftStore((store) => store.setPrompt);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const recordedWorktreePath = forceNewWorktree
    ? null
    : (serverThread?.worktreePath ?? draftThread?.worktreePath ?? null);
  // A merged task's folder is deleted ("Fusionar", storage cleanup) and comes back on the
  // thread's next turn. Until then the menu works on the project's folder instead of hiding.
  const recordedWorktreeStatus = useEnvironmentQuery(
    recordedWorktreePath === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: recordedWorktreePath } }),
  );
  const activeWorktreePath =
    recordedWorktreeStatus.data?.isRepo === false ? null : recordedWorktreePath;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== null;
  const canUpdateThreadBranch = !hasServerThread || canOperateThread;
  const canChangeThreadBranch = canWriteSourceControl && canUpdateThreadBranch;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });

  const setThreadBranch = (
    branch: string | null,
    worktreePath: string | null,
    automatic = false,
  ) => {
    if (
      !activeThreadId ||
      !activeProject ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    )
      return;
    if (serverSession && worktreePath !== activeWorktreePath) {
      void stopThreadSession({
        environmentId,
        input: { threadId: activeThreadId },
      });
    }
    if (hasServerThread) {
      void (automatic ? updateEmptyThreadMetadata : updateThreadMetadata)({
        environmentId,
        input: {
          threadId: activeThreadId,
          branch,
          worktreePath,
          ...(automatic ? { expectedEmpty: true } : {}),
        },
      });
    }
    if (hasServerThread) {
      onActiveThreadBranchOverrideChange?.(branch);
      return;
    }
    const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
      nextWorktreePath: worktreePath,
      currentWorktreePath: activeWorktreePath,
      effectiveEnvMode,
    });
    setDraftThreadContext(draftId ?? threadRef, {
      branch,
      worktreePath,
      envMode: nextDraftEnvMode,
      environmentSelection: automatic ? (draftThread?.environmentSelection ?? "auto") : "manual",
      projectRef: scopeProjectRef(environmentId, activeProject.id),
    });
  };

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  // "New branch" turns the search field into a name field for a branch off the current one.
  const [isNamingNewBranch, setIsNamingNewBranch] = useState(false);
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchStatusQuery = useEnvironmentQuery(
    branchCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: branchCwd },
        }),
  );
  const branchRefState = usePaginatedBranches({
    environmentId,
    cwd: branchCwd,
    // The server filters refs by substring, so it has to be given the sanitized
    // name as well: querying the raw "new branch" drops an existing new-branch
    // from the response entirely, which would defeat the collision check below.
    // Ref names cannot contain an ASCII space, so sanitizing loses no matches.
    query: sanitizeNewRefName(deferredBranchQuery.trim()),
  });
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  const refs = branchRefState.refs;
  const branchByName = new Map(refs.map((refName) => [refName.name, refName] as const));
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    canChangeThreadBranch && prReference && onCheckoutPullRequestRequest
      ? `__checkout_pull_request__:${prReference}`
      : null;
  const canCreateBranch =
    canChangeThreadBranch && !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const newRefName = sanitizeNewRefName(trimmedBranchQuery);
  const hasExactBranchMatch = branchByName.has(newRefName);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const defaultBranchName = refs.find((refName) => refName.isDefault)?.name ?? null;
  const pickerCreateBranchItemValue = hasExactBranchMatch ? null : createBranchItemValue;
  const branchPickerItems = [
    ...(checkoutPullRequestItemValue ? [checkoutPullRequestItemValue] : []),
    ...refs.map((refName) => refName.name),
    ...(pickerCreateBranchItemValue ? [pickerCreateBranchItemValue] : []),
  ];
  const filteredBranchPickerItems = isNamingNewBranch
    ? pickerCreateBranchItemValue
      ? [pickerCreateBranchItemValue]
      : []
    : normalizedDeferredBranchQuery.length === 0
      ? branchPickerItems
      : branchPickerItems.filter((itemValue) =>
          shouldIncludeBranchPickerItem({
            itemValue,
            normalizedQuery: normalizedDeferredBranchQuery,
            createBranchItemValue: pickerCreateBranchItemValue,
            checkoutPullRequestItemValue,
          }),
        );
  const hasNextPage =
    branchRefState.data?.nextCursor !== null && branchRefState.data?.nextCursor !== undefined;
  const isFetchingNextPage = branchRefState.isFetchingNextPage;
  const isInitialBranchesLoadPending = branchRefState.isPending && branchRefState.data === null;
  const currentGitBranch =
    branchStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = getSourceControlPresentation(
    branchStatusQuery.data?.sourceControlProvider,
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const listedActiveBranch =
    resolvedActiveBranch === null ? null : (branchByName.get(resolvedActiveBranch) ?? null);
  const activeBranchRefQuery = useEnvironmentQuery(
    branchCwd !== null && resolvedActiveBranch !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd: branchCwd,
            query: resolvedActiveBranch,
            limit: 10,
          },
        })
      : null,
  );
  const queriedActiveBranch = activeBranchRefQuery.data?.refs.find(
    (refName) => refName.name === resolvedActiveBranch,
  );
  const resolvedActiveBranchIsRemote =
    listedActiveBranch !== null
      ? listedActiveBranch.isRemote === true
      : queriedActiveBranch
        ? queriedActiveBranch.isRemote === true
        : null;
  // t3.json first, then the project's setting; otherwise staging or the default branch.
  const projectFile = useT3ProjectFileState(environmentId, activeProjectCwd);
  const environmentSettings = useEnvironmentSettings(environmentId);
  const configuredIntegrationBranch = resolveConfiguredIntegrationBranch(
    environmentSettings,
    activeProject?.id ?? null,
    projectFile.file,
    activeProject ?? undefined,
  );
  const integrationRefQuery = useEnvironmentQuery(
    isBranchMenuOpen && branchCwd !== null && !configuredIntegrationBranch
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: branchCwd, query: INTEGRATION_BRANCH_NAME, limit: 10 },
        })
      : null,
  );
  const integrationBranch = resolveIntegrationBranch(
    [...(integrationRefQuery.data?.refs ?? []), ...refs],
    configuredIntegrationBranch,
  );
  const [isNewTaskDialogOpen, setIsNewTaskDialogOpen] = useState(false);
  // Pinned when the merge starts: a permanent thread moves to its next task meanwhile, and the
  // dialog must keep showing (and never restart on) the task it was opened for.
  const [mergeTask, setMergeTask] = useState<{
    readonly cwd: string;
    readonly projectCwd: string;
    readonly branch: string;
    readonly targetRef: string;
  } | null>(null);
  const [isContinueTaskDialogOpen, setIsContinueTaskDialogOpen] = useState(false);
  const duplicateThread = useDuplicateThread();
  const handleNewThread = useNewThreadHandler();
  const projectThreads = useThreadShellsForProjectRefs(
    activeProjectRef ? [activeProjectRef] : NO_PROJECT_REFS,
  );
  // Threads that work in the project's own folder besides this one: switching the branch there
  // switches it for them too.
  const otherThreadsSharingFolder = projectThreads.filter(
    (thread) =>
      thread.id !== activeThreadId &&
      thread.worktreePath === null &&
      thread.archivedAt === null &&
      thread.settledAt === null,
  ).length;
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const totalBranchCount = branchRefState.data?.totalCount ?? 0;
  const branchStatusText = isInitialBranchesLoadPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${totalBranchCount} refs`
        : null;

  const copyBranchName = (branchName: string) => {
    void writeTextToClipboard(branchName, "branch name").then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: "Branch name copied",
          description: branchName,
        });
      },
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy branch name",
            description: toBranchActionErrorMessage(error),
          }),
        );
      },
    );
  };

  const handleBranchContextMenu = (event: ReactMouseEvent, branchName: string | null) => {
    if (!branchName) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    const items: ContextMenuItem<"copy-branch-name">[] = [
      { id: "copy-branch-name", label: "Copy branch name", icon: "copy" },
    ];
    void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
      if (action === "copy-branch-name") copyBranchName(branchName);
    });
  };

  const runBranchAction = (action: () => Promise<void>) => {
    if (
      !readEnvironmentScope(environmentId, AuthSourceControlWriteScope) ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Action unavailable",
          description: "This connection cannot change the thread's branch.",
        }),
      );
      return;
    }
    startBranchActionTransition(async () => {
      await action();
      branchRefState.refresh();
      branchStatusQuery.refresh();
    });
  };

  const selectBranch = (refName: VcsRef) => {
    if (!canUpdateThreadBranch || !branchCwd || !activeProjectCwd || isBranchActionPending) return;

    if (isSelectingWorktreeBase) {
      setThreadBranch(refName.name, null);
      handleOpenChange(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      refName,
    });

    if (selectionTarget.reuseExistingWorktree) {
      setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
      handleOpenChange(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = refName.isRemote
      ? deriveLocalBranchNameFromRemoteRef(refName.name)
      : refName.name;

    handleOpenChange(false);
    onComposerFocusRequest?.();

    const checkoutSelectedBranch = (stashChanges: boolean) =>
      runBranchAction(async () => {
        const previousBranch = resolvedActiveBranch;
        setOptimisticBranch(selectedBranchName);
        const checkoutResult = await switchRef({
          environmentId,
          input: {
            cwd: selectionTarget.checkoutCwd,
            refName: refName.name,
            ...(stashChanges ? { stashChanges } : {}),
          },
        });
        if (checkoutResult._tag === "Success") {
          const nextBranchName = refName.isRemote
            ? (checkoutResult.value.refName ?? selectedBranchName)
            : selectedBranchName;
          setOptimisticBranch(nextBranchName);
          setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
          const { stashedChanges, restoredChanges } = checkoutResult.value;
          if (stashedChanges || restoredChanges) {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `Switched to ${nextBranchName}`,
                description: [
                  stashedChanges && previousBranch
                    ? `Your uncommitted changes on ${previousBranch} are saved and come back when you switch to it again.`
                    : null,
                  restoredChanges ? `Restored the changes you left on ${nextBranchName}.` : null,
                ]
                  .filter(Boolean)
                  .join(" "),
              }),
            );
          }
          return;
        }
        setOptimisticBranch(previousBranch);
        if (isAtomCommandInterrupted(checkoutResult)) return;
        const error = squashAtomCommandFailure(checkoutResult);
        if (
          !stashChanges &&
          isGitCommandError(error) &&
          error.operation === VCS_SWITCH_REF_UNCOMMITTED_CHANGES_OPERATION
        ) {
          const toastId = toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: `Uncommitted changes block ${selectedBranchName}`,
              description: `Some edits on ${previousBranch ?? "this branch"} would be overwritten. Commit them, or stash them: they come back when you switch to ${previousBranch ?? "it"} again. Other threads in this folder see the same files.`,
              actionProps: {
                children: "Stash and switch",
                onClick: () => {
                  toastManager.close(toastId);
                  checkoutSelectedBranch(true);
                },
              },
            }),
          );
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch ref.",
            description: toBranchActionErrorMessage(error),
          }),
        );
      });

    checkoutSelectedBranch(false);
  };

  const createRef = (rawName: string) => {
    if (!canChangeThreadBranch) return;
    const name = sanitizeNewRefName(rawName);
    if (!branchCwd || !name || isBranchActionPending) return;

    handleOpenChange(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      const createBranchResult = await createRefMutation({
        environmentId,
        input: {
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        },
      });
      if (createBranchResult._tag === "Success") {
        setOptimisticBranch(createBranchResult.value.refName);
        setThreadBranch(createBranchResult.value.refName, activeWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(createBranchResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to create and switch ref.",
            description: toBranchActionErrorMessage(squashAtomCommandFailure(createBranchResult)),
          }),
        );
      }
    });
  };

  const offerConflictResolution = (input: {
    title: string;
    mergedRef: string;
    refName: string;
    conflictedFiles: ReadonlyArray<string>;
  }) => {
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: input.title,
        description: `Nothing changed. Conflicts in ${input.conflictedFiles.join(", ")}.`,
        actionProps: {
          children: "Ask the agent to resolve",
          onClick: () => {
            toastManager.close(toastId);
            setComposerPrompt(
              draftId ?? threadRef,
              buildResolveConflictsPrompt({ ...input, inProgress: false }),
            );
            onComposerFocusRequest?.();
          },
        },
      }),
    );
  };

  // Switching the branch of the project's own folder moves every thread working there.
  const startNamingNewBranch = async () => {
    if (activeWorktreePath === null && otherThreadsSharingFolder > 0) {
      const message = `Esto cambia la rama de la carpeta del proyecto para ${otherThreadsSharingFolder} ${
        otherThreadsSharingFolder === 1 ? "hilo más" : "hilos más"
      } que trabajan en ella. Para trabajar aparte sin molestar a nadie, usa «Nueva tarea». ¿Seguir igualmente?`;
      const api = readLocalApi();
      const confirmed = api ? await api.dialogs.confirm(message) : window.confirm(message);
      if (!confirmed) return;
    }
    setBranchQuery("");
    setIsNamingNewBranch(true);
  };

  const syncWithIntegrationBranch = () => {
    if (!branchCwd || !integrationBranch || isBranchActionPending) return;
    handleOpenChange(false);
    runBranchAction(async () => {
      const result = await syncWithMutation({
        environmentId,
        input: { cwd: branchCwd, baseRef: integrationBranch },
      });
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `No se pudo actualizar desde ${integrationBranch}`,
              description: toBranchActionErrorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      const { status, refName, mergedRef, conflictedFiles, stashConflict, setup } = result.value;
      if (status === "conflicted") {
        offerConflictResolution({
          title: `${mergedRef} choca con ${refName}`,
          mergedRef,
          refName,
          conflictedFiles,
        });
        return;
      }
      const setupNotice = describeWorktreeSetup(setup);
      const description = [
        stashConflict
          ? "Tus cambios sin commit chocaban con la actualización. Git guardó una copia en el stash."
          : null,
        setupNotice?.text ?? null,
      ]
        .filter((line) => line !== null)
        .join("\n");
      toastManager.add(
        stackedThreadToast({
          type: setupNotice?.failed ? "error" : stashConflict ? "warning" : "success",
          title:
            status === "up_to_date"
              ? `Ya estaba al día con ${mergedRef}`
              : `${refName} incluye ya ${mergedRef}`,
          ...(description ? { description } : {}),
        }),
      );
    });
  };

  const mergeIntoIntegrationBranch = () => {
    const sourceRef = resolvedActiveBranch;
    if (!branchCwd || !integrationBranch || !sourceRef || isBranchActionPending) return;
    handleOpenChange(false);
    runBranchAction(async () => {
      const message = `¿Fusionar ${sourceRef} en ${integrationBranch}? Este hilo pasa a ${integrationBranch} y se sube si tiene remoto. Cambia la rama de esta carpeta para todos sus hilos.`;
      const api = readLocalApi();
      const confirmed = api ? await api.dialogs.confirm(message) : window.confirm(message);
      if (!confirmed) return;
      const result = await mergeIntoMutation({
        environmentId,
        input: { cwd: branchCwd, targetRef: integrationBranch },
      });
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `No se pudo fusionar en ${integrationBranch}`,
              description: toBranchActionErrorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      const { status, targetRef, pushed, conflictedFiles } = result.value;
      if (status === "conflicted") {
        offerConflictResolution({
          title: `${sourceRef} choca con ${targetRef}`,
          mergedRef: targetRef,
          refName: sourceRef,
          conflictedFiles,
        });
        return;
      }
      setOptimisticBranch(targetRef);
      setThreadBranch(targetRef, activeWorktreePath);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${sourceRef} fusionada en ${targetRef}`,
          description: pushed
            ? "Subida: el equipo ya puede actualizarse desde ahí."
            : "Sin subir: no tiene remoto o la subida falló.",
        }),
      );
    });
  };

  const worktreeBaseBranchCandidate = isInitialBranchesLoadPending
    ? null
    : (defaultBranchName ?? currentGitBranch);

  // A started thread's server is creating its worktree and records the branch
  // itself; defaulting it here would reset the thread to the base checkout and
  // detach the agent that just started.
  const threadStarted = serverSession !== null;
  useEffect(() => {
    if (
      threadStarted ||
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !worktreeBaseBranchCandidate
    ) {
      return;
    }
    setThreadBranch(worktreeBaseBranchCandidate, null, true);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    effectiveEnvMode,
    setThreadBranch,
    threadStarted,
    worktreeBaseBranchCandidate,
  ]);

  const handleOpenChange = (open: boolean) => {
    setIsBranchMenuOpen(open);
    if (!open) {
      setBranchQuery("");
      setIsNamingNewBranch(false);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (isInitialBranchesLoadPending || isBranchActionPending) return;
        handleOpenChange(true);
      },
    }),
    [handleOpenChange, isBranchActionPending, isInitialBranchesLoadPending],
  );

  const triggerLabel = resolveBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  });

  const branchPrBranch = resolveBranchToolbarPrBranch({
    activeThreadBranch,
    resolvedActiveBranch,
  });
  const branchPr =
    branchPrBranch !== null && branchStatusQuery.data?.refName === branchPrBranch
      ? (branchStatusQuery.data.pr ?? null)
      : null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(environmentId);
  const linkedStatus = useLinkedThreadPullRequest(
    environmentId,
    serverThread?.linkedPullRequest,
    true,
    serverThread?.pullRequests,
    serverThread?.branchPullRequest,
  );
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(serverThread?.pullRequests ?? [])
    : null;
  const prBadge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(serverThread?.pullRequests)
    : null;
  const displayedPr = linkedStatus?.pr ?? (currentLinkedPr === null ? branchPr : null);
  const displayedPrStatus = prStatusIndicator(
    displayedPr,
    linkedStatus?.sourceControlProvider ?? branchStatusQuery.data?.sourceControlProvider,
  );
  const prNumber = currentLinkedPr?.number ?? displayedPr?.number;
  const prUrl = currentLinkedPr?.url ?? displayedPr?.url;
  const openPrLink = useOpenPrLink(threadRef);
  const panelPrLabel =
    prNumber === undefined
      ? ""
      : `#${prNumber}${displayedPr?.title.trim() ? `: ${displayedPr.title}` : ""}`;

  function selectPickerItem(itemValue: string) {
    if (itemValue === checkoutPullRequestItemValue && prReference && onCheckoutPullRequestRequest) {
      handleOpenChange(false);
      onComposerFocusRequest?.();
      onCheckoutPullRequestRequest(prReference);
    } else if (itemValue === createBranchItemValue) {
      createRef(trimmedBranchQuery);
    } else {
      const refName = branchByName.get(itemValue);
      if (refName) selectBranch(refName);
    }
  }

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => selectPickerItem(itemValue)}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                Checkout {sourceControlPresentation.terminology.singular}
              </span>
              <span className="truncate text-muted-foreground text-xs">{prReference}</span>
            </span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => selectPickerItem(itemValue)}
        >
          <span className="truncate">Create new ref &quot;{newRefName}&quot;</span>
        </ComboboxItem>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    return (
      <BranchPickerRefItem
        branch={refName}
        projectCwd={activeProjectCwd}
        index={index}
        value={itemValue}
        disabled={
          !canUpdateThreadBranch ||
          (!canWriteSourceControl &&
            !isSelectingWorktreeBase &&
            (!activeProjectCwd ||
              !resolveBranchSelectionTarget({
                activeProjectCwd,
                activeWorktreePath,
                refName,
              }).reuseExistingWorktree))
        }
        onClick={() => selectPickerItem(itemValue)}
        onContextMenu={(event) => handleBranchContextMenu(event, itemValue)}
      />
    );
  }

  return (
    <>
      {integrationBranch && activeProjectRef ? (
        <NewTaskDialog
          open={isNewTaskDialogOpen}
          onOpenChange={setIsNewTaskDialogOpen}
          integrationBranch={integrationBranch}
          onCreate={(name) =>
            void handleNewThread(activeProjectRef, {
              envMode: "worktree",
              branch: integrationBranch,
              worktreePath: null,
              startFromOrigin: true,
              taskName: name,
            })
          }
        />
      ) : null}
      {integrationBranch && activeProjectCwd && serverThread ? (
        <ContinueTaskDialog
          open={isContinueTaskDialogOpen}
          onOpenChange={setIsContinueTaskDialogOpen}
          environmentId={environmentId}
          threadId={serverThread.id}
          projectCwd={activeProjectCwd}
          previous={
            activeWorktreePath && resolvedActiveBranch
              ? { worktreePath: activeWorktreePath, branch: resolvedActiveBranch }
              : null
          }
          targetRef={integrationBranch}
        />
      ) : null}
      {mergeTask ? (
        <MergeTaskDialog
          open
          onOpenChange={(open) => {
            if (!open) setMergeTask(null);
          }}
          environmentId={environmentId}
          cwd={mergeTask.cwd}
          projectCwd={mergeTask.projectCwd}
          branch={mergeTask.branch}
          targetRef={mergeTask.targetRef}
          threadId={serverThread?.id ?? null}
          threadTitle={serverThread?.title ?? null}
          onAskAgent={(prompt) => {
            setComposerPrompt(draftId ?? threadRef, prompt);
            onComposerFocusRequest?.();
          }}
          onContinueTask={() => setIsContinueTaskDialogOpen(true)}
        />
      ) : null}
      <BranchPicker
        items={branchPickerItems}
        filteredItems={filteredBranchPickerItems}
        open={isBranchMenuOpen}
        onOpenChange={handleOpenChange}
        onSelectItem={selectPickerItem}
        value={resolvedActiveBranch}
        query={branchQuery}
        resultsQuery={deferredTrimmedBranchQuery}
        onQueryChange={setBranchQuery}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadNext={branchRefState.loadNext}
        statusText={branchStatusText}
        placeholder={
          isNamingNewBranch ? `New branch from ${resolvedActiveBranch ?? "HEAD"}` : undefined
        }
        footer={
          !isSelectingWorktreeBase && !isNamingNewBranch ? (
            <div className="flex flex-col border-t border-border/60 p-1">
              {integrationBranch && activeProjectRef ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="justify-start"
                  onClick={() => {
                    handleOpenChange(false);
                    setIsNewTaskDialogOpen(true);
                  }}
                >
                  <ListPlusIcon />
                  Nueva tarea
                </Button>
              ) : null}
              {integrationBranch && activeProjectCwd && serverThread ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="justify-start"
                  onClick={() => {
                    handleOpenChange(false);
                    setIsContinueTaskDialogOpen(true);
                  }}
                >
                  <MessageSquareShareIcon />
                  Seguir en una tarea nueva
                </Button>
              ) : null}
              {serverThread?.latestRun ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="justify-start"
                  onClick={() => {
                    handleOpenChange(false);
                    void duplicateThread(threadRef);
                  }}
                >
                  <CopyPlusIcon />
                  Duplicar en un hilo paralelo
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="xs"
                className="justify-start"
                onClick={() => void startNamingNewBranch()}
              >
                <GitBranchPlusIcon />
                Nueva rama desde {resolvedActiveBranch ?? "HEAD"}
              </Button>
              {integrationBranch ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="justify-start"
                  onClick={syncWithIntegrationBranch}
                >
                  <RefreshIcon aria-hidden="true" size="xs" />
                  Actualizar desde {integrationBranch}
                </Button>
              ) : null}
              {integrationBranch &&
              resolvedActiveBranch !== null &&
              resolvedActiveBranch !== integrationBranch ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="justify-start"
                  onClick={() => {
                    if (activeWorktreePath === null) {
                      mergeIntoIntegrationBranch();
                      return;
                    }
                    handleOpenChange(false);
                    if (activeProjectCwd && resolvedActiveBranch) {
                      setMergeTask({
                        cwd: activeWorktreePath,
                        projectCwd: activeProjectCwd,
                        branch: resolvedActiveBranch,
                        targetRef: integrationBranch,
                      });
                    }
                  }}
                >
                  <MergeIcon />
                  Fusionar en {integrationBranch}
                </Button>
              ) : null}
            </div>
          ) : null
        }
        renderItem={renderPickerItem}
        getItemType={(item) =>
          item === checkoutPullRequestItemValue
            ? "checkout-pull-request"
            : item === createBranchItemValue
              ? "create-branch"
              : "branch"
        }
        originControl={
          isSelectingWorktreeBase
            ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
            : undefined
        }
        popupProps={{
          align: displayMode === "panel" ? "start" : "end",
          side: displayMode === "panel" ? "bottom" : "top",
          className: cn("flex flex-col", displayMode === "panel" ? "w-(--anchor-width)" : "w-80"),
          ...(displayMode === "toolbar" ? composerFloatingLayerProps : {}),
        }}
      >
        <div
          className={cn(
            "flex min-w-0",
            displayMode === "panel" ? "w-full flex-col items-stretch" : "items-center gap-1",
            className,
          )}
        >
          {displayMode !== "panel" ? (
            <ThreadPullRequestBadgeControl
              render={<ComposerControl size="xs" />}
              badge={prBadge}
              pullRequests={serverThread?.pullRequests ?? []}
              number={prNumber}
              url={prUrl}
              status={displayedPrStatus}
              onOpenList={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
              onOpenPullRequest={(event, targetUrl = prUrl) => {
                if (targetUrl) openPrLink(event, targetUrl);
              }}
            />
          ) : null}
          <span
            className="flex min-w-0"
            onMouseDownCapture={(event) => {
              if (event.button !== 0 || event.ctrlKey) {
                event.stopPropagation();
              }
            }}
            onContextMenu={(event) => handleBranchContextMenu(event, resolvedActiveBranch)}
          >
            <ComboboxTrigger
              render={
                displayMode === "panel" ? (
                  <ThreadDetailsControl part="select" />
                ) : (
                  <ComposerControl size="xs" />
                )
              }
              className="min-w-0 max-w-full active:scale-100"
              disabled={isInitialBranchesLoadPending || isBranchActionPending}
            >
              <GitBranchIcon
                className={cn(
                  "size-3 shrink-0 opacity-70",
                  displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
                )}
              />
              <ComposerContextLabel displayMode={displayMode}>
                <MiddleTruncate
                  value={triggerLabel}
                  variant={displayMode === "panel" ? "cap-aligned" : "default"}
                  className="w-full"
                />
              </ComposerContextLabel>
              {displayMode !== "panel" ? (
                <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
              ) : null}
            </ComboboxTrigger>
          </span>
          {displayMode === "panel" && prNumber !== undefined && prUrl !== undefined ? (
            <ThreadDetailsPrRows
              threadRef={threadRef}
              links={serverThread?.pullRequests ?? []}
              currentLink={currentLinkedPr}
              onOpenLink={openPrLink}
              environmentId={environmentId}
              pr={displayedPr}
              number={prNumber}
              reference={currentLinkedPr}
              status={displayedPrStatus}
              project={activeProject}
              label={panelPrLabel}
              openAriaLabel={prUrl ?? "Open pull request"}
              onOpen={(event) => openPrLink(event, prUrl)}
              onActed={() => branchStatusQuery.refresh()}
            />
          ) : null}
        </div>
      </BranchPicker>
    </>
  );
}
