import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { forkResumeCursor } from "./forkResumeCursor.ts";

const thread = ThreadId.make("duplicate");

describe("forkResumeCursor", () => {
  it("marks Codex and Claude conversations to fork, and gives up on other providers", () => {
    expect(
      forkResumeCursor(ProviderDriverKind.make("codex"), { threadId: "codex-1" }, thread),
    ).toEqual({ threadId: "codex-1", fork: true });
    expect(
      forkResumeCursor(
        ProviderDriverKind.make("claudeAgent"),
        { threadId: "source", resume: "11111111-1111-4111-8111-111111111111", turnCount: 4 },
        thread,
      ),
    ).toEqual({
      threadId: "duplicate",
      resume: "11111111-1111-4111-8111-111111111111",
      forkSession: true,
    });
    expect(forkResumeCursor(ProviderDriverKind.make("cursor"), { id: "x" }, thread)).toBeNull();
    expect(forkResumeCursor(ProviderDriverKind.make("codex"), null, thread)).toBeNull();
  });
});
