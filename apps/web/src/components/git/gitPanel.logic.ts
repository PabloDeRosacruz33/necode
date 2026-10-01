import type { VcsLogRef, VcsStatusResult } from "@t3tools/contracts";

/** Lane and author colours, readable on both themes. */
export const GIT_GRAPH_COLORS = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
] as const;

export function graphColor(colorIndex: number): string {
  return GIT_GRAPH_COLORS[colorIndex % GIT_GRAPH_COLORS.length]!;
}

/** One label beside a commit: a branch, the remote copy of it, or a tag. */
export interface CommitRefChip {
  readonly name: string;
  readonly kind: "local" | "remote" | "tag";
  readonly current: boolean;
  /** A local branch whose remote copy points at the same commit. */
  readonly published: boolean;
}

/**
 * Groups refs by the commit they point at. A remote branch that sits on the same commit as
 * its local branch folds into it, so an up-to-date `staging` reads as one label, not two.
 */
export function chipsByCommit(refs: ReadonlyArray<VcsLogRef>): Map<string, CommitRefChip[]> {
  const remoteShaByName = new Map(
    refs.filter((ref) => ref.kind === "remote").map((ref) => [ref.name, ref.sha] as const),
  );
  const folded = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === "local" && ref.upstream && remoteShaByName.get(ref.upstream) === ref.sha) {
      folded.add(ref.upstream);
    }
  }
  const chips = new Map<string, CommitRefChip[]>();
  for (const ref of refs) {
    if (ref.kind === "remote" && folded.has(ref.name)) continue;
    const list = chips.get(ref.sha) ?? [];
    list.push({
      name: ref.name,
      kind: ref.kind,
      current: ref.current,
      published: ref.kind === "local" && ref.upstream !== null && folded.has(ref.upstream),
    });
    chips.set(ref.sha, list);
  }
  const order = { local: 0, remote: 1, tag: 2 } as const;
  for (const list of chips.values()) {
    list.sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        order[left.kind] - order[right.kind] ||
        left.name.localeCompare(right.name),
    );
  }
  return chips;
}

/** A stable colour per author, so a teammate keeps theirs across commits and sessions. */
export function authorColor(email: string, name: string): string {
  const key = (email || name).trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return graphColor(Math.abs(hash));
}

export function authorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words.at(-1)!.charAt(0) : (words[0]!.charAt(1) ?? "");
  return `${first}${last}`.toUpperCase();
}

/**
 * Changes whenever the live status shows the history may have moved: a commit (here or by an
 * agent), a pull, a push or a branch switch. The panel refetches its log when it does.
 */
export function historyRefreshKey(status: VcsStatusResult | null): string | null {
  if (status === null) return null;
  return [
    status.refName ?? "",
    status.aheadCount,
    status.behindCount,
    status.aheadOfDefaultCount ?? "",
    status.hasWorkingTreeChanges ? 1 : 0,
    status.workingTree.files.length,
  ].join(":");
}
