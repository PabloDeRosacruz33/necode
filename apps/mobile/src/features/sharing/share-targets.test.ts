import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { parsePickedShareTarget, pinnedShareTargets, sharedMessageText } from "./share-targets";

const env = EnvironmentId.make("env-1");
const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
  environmentId: env,
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: `Thread ${id}`,
  pinnedAt: "2026-10-30T10:00:00.000Z",
  pinOrderKey: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

describe("pinnedShareTargets", () => {
  it("offers pinned, live threads in pin order with their project", () => {
    expect(
      pinnedShareTargets(
        [
          thread("b", { pinOrderKey: "b" }),
          thread("a", { pinOrderKey: "a" }),
          thread("unpinned", { pinnedAt: null }),
          thread("archived", { archivedAt: "2026-10-30T11:00:00.000Z" }),
        ],
        [{ environmentId: env, id: ProjectId.make("project-1"), title: "Necora App" }],
      ),
    ).toEqual([
      { id: "env-1|a", title: "Thread a", subtitle: "Necora App" },
      { id: "env-1|b", title: "Thread b", subtitle: "Necora App" },
    ]);
  });
});

describe("parsePickedShareTarget", () => {
  const now = Date.parse("2026-10-31T18:00:00.000Z");

  it("reads the thread and comment the share extension picked", () => {
    expect(
      parsePickedShareTarget(
        JSON.stringify({ id: "env-1|thread:a|b", comment: " mira esto ", createdAt: now - 1000 }),
        now,
      ),
    ).toEqual({ environmentId: "env-1", threadId: "thread:a|b", comment: "mira esto" });
  });

  it("ignores missing, malformed and stale picks", () => {
    expect(parsePickedShareTarget(null, now)).toBeNull();
    expect(parsePickedShareTarget("{", now)).toBeNull();
    expect(
      parsePickedShareTarget(JSON.stringify({ id: "no-separator", createdAt: now }), now),
    ).toBeNull();
    expect(
      parsePickedShareTarget(
        JSON.stringify({ id: "env-1|a", comment: "", createdAt: now - 11 * 60 * 1000 }),
        now,
      ),
    ).toBeNull();
  });
});

describe("sharedMessageText", () => {
  it("puts the comment before shared text and drops empty parts", () => {
    expect(sharedMessageText("bug aquí", "https://x.test")).toBe("bug aquí\n\nhttps://x.test");
    expect(sharedMessageText("", "  ")).toBe("");
  });
});
