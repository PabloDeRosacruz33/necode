import { useLinkTo } from "@react-navigation/native";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { scheduleUnusedComposerAttachmentCleanup } from "../../state/use-composer-drafts";
import { useIncomingShare } from "./IncomingShareProvider";
import { selectIncomingShareAttachmentsForServer } from "./incoming-share-model";
import { parsePickedShareTarget, pinnedShareTargets, sharedMessageText } from "./share-targets";
import { publishPinnedShareTargets, takePickedShareTarget } from "./share-targets-native";

/** Keeps the share extension's list of pinned threads (and iOS's suggestions) current. */
export function usePublishPinnedShareTargets(): void {
  const threads = useThreadShells();
  const projects = useProjects();
  const targetsJson = useMemo(
    () => JSON.stringify(pinnedShareTargets(threads, projects)),
    [threads, projects],
  );
  useEffect(() => {
    publishPinnedShareTargets(JSON.parse(targetsJson));
  }, [targetsJson]);
}

/**
 * Sends a share the person aimed at a pinned thread straight to it, then opens the thread.
 * Returns the ids of shares it took (read in effects), so the "Start a task" sheet leaves them
 * alone.
 */
export function useShareToPinnedThread(): { readonly current: ReadonlySet<string> } {
  const { pendingShare, consumeShare } = useIncomingShare();
  const linkTo = useLinkTo();
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (pendingShare === null || handled.current.has(pendingShare.id)) return;
    const picked = parsePickedShareTarget(takePickedShareTarget(), Date.now());
    if (picked === null) return;
    const share = pendingShare;
    handled.current.add(share.id);
    const environmentId = EnvironmentId.make(picked.environmentId);
    const threadId = ThreadId.make(picked.threadId);
    void (async () => {
      const selected = selectIncomingShareAttachmentsForServer({
        attachments: share.attachments,
        serverConfig: appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
      });
      // Before the server's limits are known, send everything; the server still checks them.
      const attachments = selected.status === "pending" ? share.attachments : selected.attachments;
      await enqueueThreadOutboxMessage({
        environmentId,
        threadId,
        messageId: MessageId.make(uuidv4()),
        commandId: CommandId.make(uuidv4()),
        text: sharedMessageText(picked.comment, share.text),
        attachments,
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      });
      await consumeShare(share.id);
      const sent = new Set(attachments.map((attachment) => attachment.id));
      scheduleUnusedComposerAttachmentCleanup(
        share.attachments.filter((attachment) => !sent.has(attachment.id)),
      );
      linkTo(`/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`);
      const warnings = [
        ...share.warnings,
        ...(selected.status === "pending" ? [] : selected.warnings),
      ];
      if (warnings.length > 0) {
        Dialog.alert("Some shared content was skipped", warnings.join("\n"));
      }
    })().catch((error: unknown) => {
      handled.current.delete(share.id);
      Dialog.alert(
        "Could not send to the thread",
        error instanceof Error ? error.message : "The share stays in Necode; try again.",
      );
    });
  }, [consumeShare, linkTo, pendingShare]);

  return handled;
}
