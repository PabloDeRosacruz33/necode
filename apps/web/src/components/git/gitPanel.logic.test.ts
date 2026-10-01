import type { VcsLogRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { authorColor, authorInitials, chipsByCommit } from "./gitPanel.logic";

const ref = (overrides: Partial<VcsLogRef> & Pick<VcsLogRef, "name" | "sha">): VcsLogRef => ({
  kind: "local",
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  ...overrides,
});

describe("chipsByCommit", () => {
  it("folds a remote branch into its local branch when both sit on the same commit", () => {
    const chips = chipsByCommit([
      ref({ name: "staging", sha: "a", upstream: "origin/staging" }),
      ref({ name: "origin/staging", sha: "a", kind: "remote" }),
    ]);

    expect(chips.get("a")).toEqual([
      { name: "staging", kind: "local", current: false, published: true },
    ]);
  });

  it("keeps the remote label where it points when the local branch moved on", () => {
    const chips = chipsByCommit([
      ref({ name: "staging", sha: "b", upstream: "origin/staging", ahead: 1 }),
      ref({ name: "origin/staging", sha: "a", kind: "remote" }),
    ]);

    expect(chips.get("b")?.[0]).toMatchObject({ name: "staging", published: false });
    expect(chips.get("a")?.[0]).toMatchObject({ name: "origin/staging", kind: "remote" });
  });

  it("puts the checked-out branch first, then branches, remotes and tags", () => {
    const chips = chipsByCommit([
      ref({ name: "v1", sha: "a", kind: "tag" }),
      ref({ name: "origin/main", sha: "a", kind: "remote" }),
      ref({ name: "alpha", sha: "a" }),
      ref({ name: "zeta", sha: "a", current: true }),
    ]);

    expect(chips.get("a")?.map((chip) => chip.name)).toEqual([
      "zeta",
      "alpha",
      "origin/main",
      "v1",
    ]);
  });
});

describe("authors", () => {
  it("gives the same person the same colour whatever the case of their email", () => {
    expect(authorColor("Roi@Example.com", "Roi")).toBe(authorColor("roi@example.com", "Roi G."));
  });

  it("builds initials from one or more names", () => {
    expect(authorInitials("Pablo De Rosacruz")).toBe("PR");
    expect(authorInitials("Roi004")).toBe("RO");
    expect(authorInitials("  ")).toBe("?");
  });
});
