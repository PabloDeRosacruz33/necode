import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { markThreadUnread, markThreadVisited } from "@t3tools/client-runtime/state/thread-status";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_VISITS: Readonly<Record<string, string>> = {};

/**
 * This device's record of which thread completions the user has seen, kept in device
 * preferences like the web sidebar keeps it in the browser. Opening a thread stamps the visit
 * at the completion on screen; "Mark unread" puts it back just before that completion.
 */
export function useThreadVisits() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const lastVisitedAtById = loaded
    ? (preferencesResult.value.threadLastVisitedAtById ?? NO_VISITS)
    : NO_VISITS;
  // Consecutive stamps read the latest map even before React renders the saved one.
  const visitsRef = useRef(lastVisitedAtById);
  visitsRef.current = lastVisitedAtById;

  const save = useCallback(
    (next: Readonly<Record<string, string>>) => {
      if (next === visitsRef.current) return;
      visitsRef.current = next;
      savePreferences({ threadLastVisitedAtById: next });
    },
    [savePreferences],
  );
  const markVisited = useCallback(
    (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">, visitedAt: string) => {
      if (!loaded) return;
      save(
        markThreadVisited(
          visitsRef.current,
          scopedThreadKey(thread.environmentId, thread.id),
          visitedAt,
        ),
      );
    },
    [loaded, save],
  );
  const markUnread = useCallback(
    (thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "latestTurn">) => {
      if (!loaded) return;
      save(
        markThreadUnread(
          visitsRef.current,
          scopedThreadKey(thread.environmentId, thread.id),
          thread.latestTurn?.completedAt,
        ),
      );
    },
    [loaded, save],
  );

  return useMemo(
    () => ({ lastVisitedAtById, markVisited, markUnread }),
    [lastVisitedAtById, markVisited, markUnread],
  );
}
