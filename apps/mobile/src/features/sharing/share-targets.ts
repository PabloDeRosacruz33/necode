/**
 * Necode: pinned threads as destinations in the iOS share sheet. The app publishes them to the
 * share extension (see T3ShareTargetsModule.swift); the extension hands back the one the person
 * picked with their comment, and the shared items go straight to that thread.
 */
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export interface PinnedShareTarget {
  /** `environmentId|threadId`, the conversation id iOS remembers. */
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface PickedShareTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly comment: string;
}

const SEPARATOR = "|";
/** A pick older than this belongs to a share that never reached the app. */
const PICK_MAX_AGE_MS = 10 * 60 * 1000;

export function pinnedShareTargets(
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "environmentId"
      | "id"
      | "projectId"
      | "title"
      | "pinnedAt"
      | "pinOrderKey"
      | "archivedAt"
      | "deletedAt"
    >
  >,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>,
): ReadonlyArray<PinnedShareTarget> {
  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}${SEPARATOR}${project.id}`, project.title]),
  );
  return [...threads]
    .filter((thread) => thread.pinnedAt != null && thread.archivedAt == null && !thread.deletedAt)
    .sort(
      (left, right) =>
        (left.pinOrderKey ?? "").localeCompare(right.pinOrderKey ?? "") ||
        (left.pinnedAt ?? "").localeCompare(right.pinnedAt ?? ""),
    )
    .map((thread) => ({
      id: `${thread.environmentId}${SEPARATOR}${thread.id}`,
      title: thread.title,
      subtitle:
        projectTitles.get(`${thread.environmentId}${SEPARATOR}${thread.projectId}`) ?? "Necode",
    }));
}

export function parsePickedShareTarget(
  json: string | null,
  nowMs: number,
): PickedShareTarget | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as { id?: unknown; comment?: unknown; createdAt?: unknown };
    if (typeof value.id !== "string" || typeof value.createdAt !== "number") return null;
    if (nowMs - value.createdAt > PICK_MAX_AGE_MS) return null;
    const separator = value.id.indexOf(SEPARATOR);
    if (separator <= 0 || separator === value.id.length - 1) return null;
    return {
      environmentId: value.id.slice(0, separator),
      threadId: value.id.slice(separator + 1),
      comment: typeof value.comment === "string" ? value.comment.trim() : "",
    };
  } catch {
    return null;
  }
}

/** The comment first, then any text that came with the share (a link, a note). */
export function sharedMessageText(comment: string, sharedText: string): string {
  return [comment, sharedText.trim()].filter((part) => part.length > 0).join("\n\n");
}
