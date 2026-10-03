import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

// Domain Types

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

// RPC Inputs

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
  /** The thread the action runs beside; a pull request it creates is linked to it. */
  threadId: Schema.optional(ThreadId),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  baseRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  /** Stash uncommitted work for the current branch first; switching back to it restores the stash. */
  stashChanges: Schema.optional(Schema.Boolean),
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

/** Merges the checked-out branch into `targetRef` and publishes it when it tracks a remote. */
export const VcsMergeIntoInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetRef: TrimmedNonEmptyStringSchema,
});
export type VcsMergeIntoInput = typeof VcsMergeIntoInput.Type;

export const VcsMergeIntoResult = Schema.Struct({
  status: Schema.Literals(["merged", "conflicted"]),
  sourceRef: TrimmedNonEmptyStringSchema,
  targetRef: TrimmedNonEmptyStringSchema,
  /** Whether the merged target reached its remote. False when it has none or the push failed. */
  pushed: Schema.Boolean,
  conflictedFiles: Schema.Array(Schema.String),
});
export type VcsMergeIntoResult = typeof VcsMergeIntoResult.Type;

/** Brings the latest `baseRef` (from its remote when it has one) into the checked-out branch. */
export const VcsSyncWithInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  baseRef: TrimmedNonEmptyStringSchema,
});
export type VcsSyncWithInput = typeof VcsSyncWithInput.Type;

/**
 * The task's setup script ran again because new lockfiles came in. A non-zero or null exit
 * code means the task's dependencies may not match its code; `output` is the end of its log.
 */
export const VcsWorktreeSetupRun = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
});
export type VcsWorktreeSetupRun = typeof VcsWorktreeSetupRun.Type;

export const VcsSyncWithResult = Schema.Struct({
  status: Schema.Literals(["updated", "up_to_date", "conflicted"]),
  refName: TrimmedNonEmptyStringSchema,
  /** The ref that was merged in, e.g. `origin/staging`. */
  mergedRef: TrimmedNonEmptyStringSchema,
  conflictedFiles: Schema.Array(Schema.String),
  /** Uncommitted work clashed with the update; git kept it in the stash. */
  stashConflict: Schema.Boolean,
  setup: Schema.optional(VcsWorktreeSetupRun),
});
export type VcsSyncWithResult = typeof VcsSyncWithResult.Type;

/**
 * Merging a task worktree into the integration branch without checking that branch out
 * anywhere: prepare (bring the integration branch into the worktree), check (the project's
 * pre-merge script), publish (build the merge commit in memory and push it).
 */
export const VcsMergeTaskPrepareInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetRef: TrimmedNonEmptyStringSchema,
});
export type VcsMergeTaskPrepareInput = typeof VcsMergeTaskPrepareInput.Type;

export const VcsMergeTaskPrepareResult = Schema.Union([
  /** Uncommitted work blocks the merge. */
  Schema.TaggedStruct("dirty", { files: Schema.Array(Schema.String) }),
  /** The integration branch conflicts; the merge is left in progress in the worktree. */
  Schema.TaggedStruct("conflicted", {
    mergedRef: TrimmedNonEmptyStringSchema,
    conflictedFiles: Schema.Array(Schema.String),
  }),
  /** The integration branch already has everything this task holds. */
  Schema.TaggedStruct("upToDate", { mergedRef: TrimmedNonEmptyStringSchema }),
  Schema.TaggedStruct("ready", {
    branch: TrimmedNonEmptyStringSchema,
    mergedRef: TrimmedNonEmptyStringSchema,
    /** The commit the pre-merge check runs against and publish must still find. */
    headSha: TrimmedNonEmptyStringSchema,
  }),
]);
export type VcsMergeTaskPrepareResult = typeof VcsMergeTaskPrepareResult.Type;

export const VcsMergeTaskCheckInput = Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
export type VcsMergeTaskCheckInput = typeof VcsMergeTaskCheckInput.Type;

export const VcsMergeTaskCheckEvent = Schema.Union([
  /** The task's setup script runs first because its lockfiles changed since it last ran. */
  Schema.TaggedStruct("setup", { name: Schema.String, command: Schema.String }),
  /** The setup script failed; nothing else runs and the merge must not go ahead. */
  Schema.TaggedStruct("setupFailed", { exitCode: Schema.NullOr(Schema.Int) }),
  /** `command` is null when the project declares no pre-merge check. */
  Schema.TaggedStruct("started", { command: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("output", { text: Schema.String }),
  Schema.TaggedStruct("finished", { exitCode: Schema.NullOr(Schema.Int) }),
]);
export type VcsMergeTaskCheckEvent = typeof VcsMergeTaskCheckEvent.Type;

/**
 * What a task merge brings together, for the person merging: the work that reached the
 * integration branch since the task started (each entry one merge or direct commit, with the
 * summary its own merge recorded) and a plain-language summary of the task itself.
 */
export const VcsMergeTaskReviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetRef: TrimmedNonEmptyStringSchema,
});
export type VcsMergeTaskReviewInput = typeof VcsMergeTaskReviewInput.Type;

export const VcsMergeTaskReviewEntry = Schema.Struct({
  commit: TrimmedNonEmptyStringSchema,
  author: Schema.String,
  /** ISO 8601. */
  date: Schema.String,
  title: Schema.String,
  summary: Schema.Array(Schema.String),
  howToTest: Schema.Array(Schema.String),
});
export type VcsMergeTaskReviewEntry = typeof VcsMergeTaskReviewEntry.Type;

export const VcsMergeTaskReviewResult = Schema.Struct({
  incoming: Schema.Array(VcsMergeTaskReviewEntry),
  /** True when more entries arrived than `incoming` lists. */
  incomingTruncated: Schema.Boolean,
  own: Schema.Struct({
    title: Schema.String,
    summary: Schema.Array(Schema.String),
    howToTest: Schema.Array(Schema.String),
    /** False when the summary could not be written and only lists the task's commits. */
    generated: Schema.Boolean,
  }),
  /** Files changed both by the incoming work and by the task. */
  sharedFiles: Schema.Array(Schema.String),
});
export type VcsMergeTaskReviewResult = typeof VcsMergeTaskReviewResult.Type;

const SUMMARY_HEADING = "## Resumen";
const HOW_TO_TEST_HEADING = "## Cómo probarlo";

/**
 * The merge commit message of a task: its subject, the thread's title, and the plain-language
 * summary and manual test steps that the next person merging reads back as incoming work.
 */
export function formatTaskMergeMessage(input: {
  readonly branch: string;
  readonly targetRef: string;
  readonly title: string | null;
  readonly summary: ReadonlyArray<string>;
  readonly howToTest: ReadonlyArray<string>;
  /** Incoming work the person merging tried by hand together with this task. */
  readonly testedWith: ReadonlyArray<string>;
}): string {
  const section = (heading: string, items: ReadonlyArray<string>) =>
    items.length > 0 ? [heading, ...items.map((item) => `- ${item}`)].join("\n") : null;
  return [
    `merge: ${input.branch} into ${input.targetRef}`,
    input.title,
    section(SUMMARY_HEADING, input.summary),
    section(HOW_TO_TEST_HEADING, input.howToTest),
    section("## Probado a mano junto con", input.testedWith),
  ]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join("\n\n");
}

/** Reads back what `formatTaskMergeMessage` recorded; empty lists for other commits. */
export function parseTaskMergeMessage(body: string): {
  readonly title: string | null;
  readonly summary: ReadonlyArray<string>;
  readonly howToTest: ReadonlyArray<string>;
} {
  const summary: Array<string> = [];
  const howToTest: Array<string> = [];
  let title: string | null = null;
  let section: Array<string> | null = null;
  let inHeadingSection = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      inHeadingSection = true;
      section =
        line === SUMMARY_HEADING ? summary : line === HOW_TO_TEST_HEADING ? howToTest : null;
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (bullet && section) section.push(bullet);
    else if (line && !inHeadingSection && title === null) title = line;
  }
  return { title, summary, howToTest };
}

export const VcsMergeTaskPublishInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetRef: TrimmedNonEmptyStringSchema,
  headSha: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema,
  /** The task's thread: a successful merge is noted in it with the commit. */
  threadId: Schema.optional(ThreadId),
});
export type VcsMergeTaskPublishInput = typeof VcsMergeTaskPublishInput.Type;

export const VcsMergeTaskPublishResult = Schema.Union([
  Schema.TaggedStruct("merged", {
    commit: TrimmedNonEmptyStringSchema,
    targetRef: TrimmedNonEmptyStringSchema,
    /** False when the local integration branch is checked out elsewhere or diverged. */
    localTargetUpdated: Schema.Boolean,
  }),
  /** The worktree or the integration branch moved since prepare: prepare and check again. */
  Schema.TaggedStruct("stale", { reason: Schema.Literals(["head-moved", "target-moved"]) }),
]);
export type VcsMergeTaskPublishResult = typeof VcsMergeTaskPublishResult.Type;

export const VcsMergeAbortInput = Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
export type VcsMergeAbortInput = typeof VcsMergeAbortInput.Type;

/** Removes a merged task: its worktree, its local branch and, if asked, the remote branch. */
export const VcsCloseTaskInput = Schema.Struct({
  projectCwd: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  /** The branch is deleted only once `origin/<targetRef>` contains it. */
  targetRef: TrimmedNonEmptyStringSchema,
  deleteRemote: Schema.Boolean,
  /** The task's thread, moved back to the project's folder once the task's folder is gone. */
  threadId: Schema.optional(ThreadId),
});
export type VcsCloseTaskInput = typeof VcsCloseTaskInput.Type;

export const VcsCloseTaskResult = Schema.Struct({
  removedWorktree: Schema.Boolean,
  deletedBranch: Schema.Boolean,
  deletedRemote: Schema.Boolean,
});
export type VcsCloseTaskResult = typeof VcsCloseTaskResult.Type;

/**
 * Moves a thread to a new task: closes the one it worked in (when its folder is still there) and
 * gives it a new branch and folder from the latest integration branch, keeping the conversation.
 */
export const VcsContinueTaskInput = Schema.Struct({
  threadId: ThreadId,
  projectCwd: TrimmedNonEmptyStringSchema,
  /** The task the thread is leaving; null when it has no folder of its own. */
  previous: Schema.NullOr(
    Schema.Struct({
      worktreePath: TrimmedNonEmptyStringSchema,
      branch: TrimmedNonEmptyStringSchema,
    }),
  ),
  targetRef: TrimmedNonEmptyStringSchema,
  taskName: TrimmedNonEmptyStringSchema,
  branchPrefix: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type VcsContinueTaskInput = typeof VcsContinueTaskInput.Type;

export const VcsContinueTaskResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema,
});
export type VcsContinueTaskResult = typeof VcsContinueTaskResult.Type;

export const VCS_LOG_MAX_LIMIT = 2000;

/** Newest-first history of every branch, remote branch and tag, for the Git panel's graph. */
export const VcsLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(VCS_LOG_MAX_LIMIT))),
});
export type VcsLogInput = typeof VcsLogInput.Type;

export const VcsLogCommit = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  parents: Schema.Array(TrimmedNonEmptyStringSchema),
  authorName: Schema.String,
  authorEmail: Schema.String,
  /** ISO 8601. */
  authoredAt: Schema.String,
  subject: Schema.String,
});
export type VcsLogCommit = typeof VcsLogCommit.Type;

export const VcsLogRef = Schema.Struct({
  /** Short name: `staging`, `origin/staging`, `v1.2.0`. */
  name: TrimmedNonEmptyStringSchema,
  kind: Schema.Literals(["local", "remote", "tag"]),
  sha: TrimmedNonEmptyStringSchema,
  current: Schema.Boolean,
  /** Local branches only: the remote branch it tracks, if any. */
  upstream: Schema.NullOr(TrimmedNonEmptyStringSchema),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
});
export type VcsLogRef = typeof VcsLogRef.Type;

export const VcsLogResult = Schema.Struct({
  /** Topological order, newest first: a commit always comes before its parents. */
  commits: Schema.Array(VcsLogCommit),
  refs: Schema.Array(VcsLogRef),
  headSha: Schema.NullOr(TrimmedNonEmptyStringSchema),
  currentBranch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** Older commits exist beyond `limit`. */
  hasMore: Schema.Boolean,
  /** Files with uncommitted changes in the working tree. */
  uncommittedFiles: NonNegativeInt,
  stashes: NonNegativeInt,
});
export type VcsLogResult = typeof VcsLogResult.Type;

export const VcsCommitDetailsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  sha: TrimmedNonEmptyStringSchema,
});
export type VcsCommitDetailsInput = typeof VcsCommitDetailsInput.Type;

export const VcsCommitFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type VcsCommitFile = typeof VcsCommitFile.Type;

export const VcsCommitDetailsResult = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  parents: Schema.Array(TrimmedNonEmptyStringSchema),
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAt: Schema.String,
  committerName: Schema.String,
  committedAt: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  /** Changes against the first parent; a merge shows what it brought in. */
  files: Schema.Array(VcsCommitFile),
  diff: Schema.String,
  /** The patch was cut short; `files` is still complete. */
  truncated: Schema.Boolean,
});
export type VcsCommitDetailsResult = typeof VcsCommitDetailsResult.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

// RPC Results

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
  /** Optional for compatibility with older servers and providers. */
  isDraft: Schema.optional(Schema.Boolean),
  /**
   * Last provider-side activity (ISO), including comments and metadata edits.
   * This is not the time a change request closed or merged. Optional for old
   * servers and providers whose lookups do not report it.
   */
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /**
   * False when the checkout could not be brought to the pull request head — a reused worktree
   * holding local commits or uncommitted changes keeps its own state, so the code being handed
   * over is older than the pull request.
   */
  isOnPullRequestHead: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** Uncommitted work was stashed for the branch that was left. */
  stashedChanges: Schema.optional(Schema.Boolean),
  /** Work stashed earlier for the new branch was put back. */
  restoredChanges: Schema.optional(Schema.Boolean),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  setup: Schema.optional(VcsWorktreeSetupRun),
});
export type VcsPullResult = typeof VcsPullResult.Type;

// RPC / domain errors
/** `GitCommandError.operation` when uncommitted work blocks a branch switch; retry with `stashChanges`. */
export const VCS_SWITCH_REF_UNCOMMITTED_CHANGES_OPERATION =
  "GitVcsDriver.switchRef.uncommittedChanges";

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedError<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitPullRequestMaterializationError extends Schema.TaggedError<GitPullRequestMaterializationError>()(
  "GitPullRequestMaterializationError",
  {
    cwd: TrimmedNonEmptyStringSchema,
    pullRequestNumber: PositiveInt,
    headRepository: Schema.NullOr(TrimmedNonEmptyStringSchema),
    headBranch: TrimmedNonEmptyStringSchema,
    localBranch: TrimmedNonEmptyStringSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to materialize pull request #${this.pullRequestNumber} branch ${this.headBranch} as ${this.localBranch}.`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitPullRequestMaterializationError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
