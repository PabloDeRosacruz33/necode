/**
 * Git right-panel surface: the repository's history as a branch graph, with who
 * made each commit, where every local and remote branch points, and how the
 * checked-out branch stands against its remote. Selecting a commit opens its
 * message and changes below the graph.
 */
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import type { EnvironmentId, VcsLogCommit, VcsLogRef } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CloudDownloadIcon,
  CloudIcon,
  CloudUploadIcon,
  CopyIcon,
  FilePenLineIcon,
  GitBranchIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import * as Cause from "effect/Cause";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  fnv1a32,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction, useVcsPullAction } from "~/state/sourceControlActions";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { describeWorktreeSetup } from "./worktreeSetupNotice";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { layoutCommitGraph, type GraphRow, type GraphSegment } from "./commitGraph.logic";
import {
  authorColor,
  authorInitials,
  chipsByCommit,
  graphColor,
  historyRefreshKey,
  type CommitRefChip,
} from "./gitPanel.logic";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 12;
/** Lanes past this many are clipped; a wider graph would push the messages off screen. */
const MAX_VISIBLE_LANES = 10;
const HISTORY_LIMIT = 500;

export function GitPanel({
  environmentId,
  cwd,
  onOpenWorkingTreeDiff,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  onOpenWorkingTreeDiff: () => void;
}) {
  const [limit, setLimit] = useState(HISTORY_LIMIT);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const log = useEnvironmentQuery(vcsEnvironment.log({ environmentId, input: { cwd, limit } }));
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));

  // An agent's commit, a teammate's push picked up by the background fetch, or a switch made
  // elsewhere all show up in the live status first; the history follows it.
  const refreshKey = historyRefreshKey(status.data);
  const lastRefreshKey = useRef(refreshKey);
  const refreshLog = log.refresh;
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    refreshLog();
  }, [refreshKey, refreshLog]);

  const history = log.data;
  const layout = useMemo(() => layoutCommitGraph(history?.commits ?? []), [history?.commits]);
  const chips = useMemo(() => chipsByCommit(history?.refs ?? []), [history?.refs]);
  const graphWidth = Math.min(layout.maxWidth, MAX_VISIBLE_LANES) * LANE_WIDTH + 4;

  if (history === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {log.error ?? <Spinner className="size-4" />}
      </div>
    );
  }

  const currentRef =
    history.refs.find((ref) => ref.kind === "local" && ref.current) ??
    (history.currentBranch
      ? history.refs.find((ref) => ref.kind === "local" && ref.name === history.currentBranch)
      : undefined);

  return (
    <div className="@container/git flex h-full min-h-0 flex-col bg-background">
      <GitPanelHeader
        environmentId={environmentId}
        cwd={cwd}
        currentBranch={history.currentBranch}
        currentRef={currentRef ?? null}
        uncommittedFiles={history.uncommittedFiles}
        stashes={history.stashes}
        isRefreshing={log.isPending}
        onRefresh={refreshLog}
        onOpenWorkingTreeDiff={onOpenWorkingTreeDiff}
        onSelectCommit={setSelectedSha}
      />
      <div className={cn("min-h-0", selectedSha ? "h-1/2 shrink-0" : "flex-1")}>
        {history.commits.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No commits yet.
          </div>
        ) : (
          <LegendList<VcsLogCommit>
            data={history.commits as VcsLogCommit[]}
            keyExtractor={(commit) => commit.sha}
            estimatedItemSize={ROW_HEIGHT}
            drawDistance={ROW_HEIGHT * 20}
            recycleItems
            className="h-full overflow-x-hidden"
            renderItem={({ item, index }) => (
              <CommitRow
                commit={item}
                row={layout.rows[index]!}
                graphWidth={graphWidth}
                chips={chips.get(item.sha)}
                isHead={item.sha === history.headSha}
                selected={item.sha === selectedSha}
                onSelect={setSelectedSha}
              />
            )}
            ListFooterComponent={
              history.hasMore ? (
                <div className="flex justify-center py-2">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setLimit((current) => current + HISTORY_LIMIT)}
                  >
                    Show older commits
                  </Button>
                </div>
              ) : null
            }
          />
        )}
      </div>
      {selectedSha ? (
        <CommitDetails
          environmentId={environmentId}
          cwd={cwd}
          sha={selectedSha}
          chips={chips.get(selectedSha)}
          onSelectCommit={setSelectedSha}
          onClose={() => setSelectedSha(null)}
        />
      ) : null}
    </div>
  );
}

function GitPanelHeader({
  environmentId,
  cwd,
  currentBranch,
  currentRef,
  uncommittedFiles,
  stashes,
  isRefreshing,
  onRefresh,
  onOpenWorkingTreeDiff,
  onSelectCommit,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  currentBranch: string | null;
  currentRef: VcsLogRef | null;
  uncommittedFiles: number;
  stashes: number;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpenWorkingTreeDiff: () => void;
  onSelectCommit: (sha: string) => void;
}) {
  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
  const pull = useVcsPullAction(scope);
  const push = useGitStackedAction(scope);
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const [fetching, setFetching] = useState(false);

  const fetchRemote = async () => {
    setFetching(true);
    const result = await refreshStatus({ environmentId, input: { cwd } });
    setFetching(false);
    onRefresh();
    if (result._tag === "Failure") toastManager.add({ type: "error", title: "Fetch failed." });
  };
  const branchLabel = currentBranch ?? "the branch";
  const runPull = async () => {
    const result = await pull.run();
    if (result._tag === "Success") {
      const setupNotice = describeWorktreeSetup(result.value.setup);
      toastManager.add({
        type: setupNotice?.failed ? "error" : "success",
        title: `Pulled ${branchLabel}`,
        ...(setupNotice ? { description: setupNotice.text } : {}),
      });
    } else {
      toastManager.add({
        type: "error",
        title: "Pull failed.",
        description: failureMessage(result),
      });
    }
  };
  const runPush = async () => {
    const result = await push.run({ actionId: randomUUID(), action: "push" });
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Pushed ${branchLabel}` });
    } else {
      toastManager.add({
        type: "error",
        title: "Push failed.",
        description: failureMessage(result),
      });
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <button
          type="button"
          className="min-w-0 truncate text-sm font-medium hover:underline"
          disabled={!currentRef}
          onClick={() => currentRef && onSelectCommit(currentRef.sha)}
        >
          {currentBranch ?? "Detached HEAD"}
        </button>
        {currentRef ? <SyncState branch={currentRef} /> : null}
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          <HeaderAction label="Fetch" onClick={fetchRemote} pending={fetching || isRefreshing}>
            <RefreshIcon />
          </HeaderAction>
          <HeaderAction
            label={currentRef?.behind ? `Pull ${currentRef.behind}` : "Pull"}
            onClick={runPull}
            pending={pull.isPending}
          >
            <CloudDownloadIcon />
          </HeaderAction>
          <HeaderAction
            label={currentRef?.ahead ? `Push ${currentRef.ahead}` : "Push"}
            onClick={runPush}
            pending={push.isPending}
            disabled={!currentBranch}
          >
            <CloudUploadIcon />
          </HeaderAction>
        </div>
      </div>
      {uncommittedFiles > 0 || stashes > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {uncommittedFiles > 0 ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-foreground"
              onClick={onOpenWorkingTreeDiff}
            >
              <FilePenLineIcon className="size-3" />
              {uncommittedFiles} uncommitted {uncommittedFiles === 1 ? "file" : "files"}
            </button>
          ) : null}
          {stashes > 0 ? (
            <span className="inline-flex items-center gap-1">
              <ArchiveIcon className="size-3" />
              {stashes} {stashes === 1 ? "stash" : "stashes"}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function SyncState({ branch }: { branch: VcsLogRef }) {
  if (!branch.upstream) {
    return <span className="shrink-0 text-xs text-muted-foreground">Not published</span>;
  }
  if (branch.ahead === 0 && branch.behind === 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <CheckIcon className="size-3" />
        {branch.upstream}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      {branch.ahead > 0 ? (
        <span className="inline-flex items-center text-success-foreground">
          <ArrowUpIcon className="size-3" />
          {branch.ahead}
        </span>
      ) : null}
      {branch.behind > 0 ? (
        <span className="inline-flex items-center text-warning-foreground">
          <ArrowDownIcon className="size-3" />
          {branch.behind}
        </span>
      ) : null}
    </span>
  );
}

function HeaderAction({
  label,
  onClick,
  pending,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  pending: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={pending || disabled}
            onClick={onClick}
          />
        }
      >
        {pending ? <Spinner className="size-3.5" /> : children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

const CommitRow = memo(function CommitRow({
  commit,
  row,
  graphWidth,
  chips,
  isHead,
  selected,
  onSelect,
}: {
  commit: VcsLogCommit;
  row: GraphRow;
  graphWidth: number;
  chips: ReadonlyArray<CommitRefChip> | undefined;
  isHead: boolean;
  selected: boolean;
  onSelect: (sha: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(commit.sha)}
      className={cn(
        "flex w-full items-center gap-2 pe-3 text-left text-xs",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <GraphCell row={row} width={graphWidth} isHead={isHead} isMerge={commit.parents.length > 1} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {chips?.map((chip) => (
          <RefChip
            key={`${chip.kind}:${chip.name}`}
            chip={chip}
            color={graphColor(row.colorIndex)}
          />
        ))}
        <span
          className={cn(
            "min-w-0 truncate",
            commit.parents.length > 1 && "text-muted-foreground",
            isHead && "font-medium",
          )}
        >
          {commit.subject}
        </span>
      </span>
      <AuthorAvatar name={commit.authorName} email={commit.authorEmail} />
      <span className="hidden w-24 shrink-0 truncate text-muted-foreground @md/git:inline">
        {commit.authorName}
      </span>
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
        {formatRelativeTimeLabel(commit.authoredAt)}
      </span>
    </button>
  );
});

function GraphCell({
  row,
  width,
  isHead,
  isMerge,
}: {
  row: GraphRow;
  width: number;
  isHead: boolean;
  isMerge: boolean;
}) {
  const center = ROW_HEIGHT / 2;
  const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2 + 2;
  const path = (segment: GraphSegment, fromY: number, toY: number) => {
    const fromX = x(segment.fromLane);
    const toX = x(segment.toLane);
    if (fromX === toX) return `M${fromX} ${fromY}V${toY}`;
    const midY = (fromY + toY) / 2;
    return `M${fromX} ${fromY}C${fromX} ${midY} ${toX} ${midY} ${toX} ${toY}`;
  };
  const color = graphColor(row.colorIndex);
  return (
    <svg
      aria-hidden
      width={width}
      height={ROW_HEIGHT}
      className="shrink-0 overflow-hidden"
      fill="none"
      strokeWidth={1.5}
    >
      {row.top.map((segment) => (
        <path
          key={`t${segment.fromLane}-${segment.toLane}`}
          d={path(segment, 0, center)}
          stroke={graphColor(segment.colorIndex)}
        />
      ))}
      {row.bottom.map((segment) => (
        <path
          key={`b${segment.fromLane}-${segment.toLane}`}
          d={path(segment, center, ROW_HEIGHT)}
          stroke={graphColor(segment.colorIndex)}
        />
      ))}
      {isHead ? (
        <circle
          cx={x(row.lane)}
          cy={center}
          r={4.5}
          fill="var(--background)"
          stroke={color}
          strokeWidth={2}
        />
      ) : (
        <circle
          cx={x(row.lane)}
          cy={center}
          r={isMerge ? 2.5 : 3.5}
          fill={isMerge ? "var(--background)" : color}
          stroke={color}
        />
      )}
    </svg>
  );
}

function RefChip({ chip, color }: { chip: CommitRefChip; color: string }) {
  const Icon = chip.kind === "tag" ? TagIcon : chip.kind === "remote" ? CloudIcon : null;
  return (
    <Badge
      variant="label"
      size="sm"
      className="shrink-0"
      style={{ "--label": color } as React.CSSProperties}
      aria-label={chip.published ? `${chip.name}, in sync with its remote` : chip.name}
    >
      {chip.current ? <CheckIcon className="size-2.5" /> : null}
      {Icon ? <Icon className="size-2.5" /> : null}
      <span className={cn("max-w-32 truncate", chip.current && "font-semibold")}>{chip.name}</span>
      {chip.published ? <CloudIcon className="size-2.5 opacity-70" /> : null}
    </Badge>
  );
}

function AuthorAvatar({ name, email }: { name: string; email: string }) {
  const color = authorColor(email, name);
  return (
    <span
      aria-label={email ? `${name} <${email}>` : name}
      className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-full text-4xs font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {authorInitials(name)}
    </span>
  );
}

function CommitDetails({
  environmentId,
  cwd,
  sha,
  chips,
  onSelectCommit,
  onClose,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  sha: string;
  chips: ReadonlyArray<CommitRefChip> | undefined;
  onSelectCommit: (sha: string) => void;
  onClose: () => void;
}) {
  const details = useEnvironmentQuery(
    vcsEnvironment.commitDetails({ environmentId, input: { cwd, sha } }),
  );
  const { resolvedTheme } = useTheme();
  const commit = details.data;
  const items = useMemo<CodeViewDiffItem<undefined>[]>(() => {
    if (!commit) return [];
    const patch = getRenderablePatch(commit.diff, `git-commit:${commit.sha}:${resolvedTheme}`);
    if (patch?.kind !== "files") return [];
    return patch.files.map((fileDiff) => ({
      id: resolveFileDiffPath(fileDiff),
      type: "diff" as const,
      fileDiff,
      collapsed: false,
      version: fnv1a32(`${commit.sha}:${resolveFileDiffPath(fileDiff)}`),
    }));
  }, [commit, resolvedTheme]);
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      theme: resolveDiffThemeName(resolvedTheme),
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      themeType: resolvedTheme,
      stickyHeaders: true,
    }),
    [resolvedTheme],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
      <div className="flex shrink-0 flex-col gap-1.5 px-3 py-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium">{commit?.subject ?? " "}</p>
          <Button variant="ghost" size="icon-xs" aria-label="Close commit" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        {commit ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <AuthorAvatar name={commit.authorName} email={commit.authorEmail} />
                <span className="text-foreground">{commit.authorName}</span>
              </span>
              <span>{new Date(commit.authoredAt).toLocaleString()}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 font-mono hover:text-foreground"
                onClick={() => void writeTextToClipboard(commit.sha)}
                aria-label="Copy SHA"
              >
                {commit.sha.slice(0, 8)}
                <CopyIcon className="size-3" />
              </button>
              {commit.parents.map((parent) => (
                <button
                  key={parent}
                  type="button"
                  className="font-mono underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => onSelectCommit(parent)}
                  aria-label={`Go to parent ${parent.slice(0, 7)}`}
                >
                  ↳ {parent.slice(0, 7)}
                </button>
              ))}
              {chips?.map((chip) => (
                <RefChip
                  key={`${chip.kind}:${chip.name}`}
                  chip={chip}
                  color="var(--muted-foreground)"
                />
              ))}
            </div>
            {commit.body ? (
              <p className="max-h-24 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground">
                {commit.body}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {commit.files.length} {commit.files.length === 1 ? "file" : "files"} ·{" "}
              <span className="text-success-foreground">
                +{commit.files.reduce((sum, file) => sum + file.additions, 0)}
              </span>{" "}
              <span className="text-destructive-foreground">
                −{commit.files.reduce((sum, file) => sum + file.deletions, 0)}
              </span>
              {commit.truncated ? " · Large commit, some files not shown" : null}
            </p>
          </>
        ) : details.error ? (
          <p className="text-xs text-destructive-foreground">{details.error}</p>
        ) : (
          <Spinner className="size-4" />
        )}
      </div>
      {items.length > 0 ? (
        <StyledDiffCodeView<undefined>
          className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]"
          items={items}
          options={options}
        />
      ) : null}
    </div>
  );
}
