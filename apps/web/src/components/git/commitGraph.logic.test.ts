import { describe, expect, it } from "vite-plus/test";

import { layoutCommitGraph } from "./commitGraph.logic";

const commit = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("layoutCommitGraph", () => {
  it("keeps a straight history in one lane", () => {
    const { rows, maxWidth } = layoutCommitGraph([commit("c", "b"), commit("b", "a"), commit("a")]);

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(maxWidth).toBe(1);
    expect(rows[0]!.top).toEqual([]);
    expect(rows[2]!.bottom).toEqual([]);
  });

  it("opens a lane for a merged branch and closes it at the fork point", () => {
    // m merges f into main; f and b both come from a.
    const { rows, maxWidth } = layoutCommitGraph([
      commit("m", "b", "f"),
      commit("f", "a"),
      commit("b", "a"),
      commit("a"),
    ]);

    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
    expect(maxWidth).toBe(2);
    expect(rows[0]!.bottom).toContainEqual(expect.objectContaining({ fromLane: 0, toLane: 1 }));
    // Both lanes wait for a, so the side lane bends back into the main one there.
    expect(rows[3]!.top).toContainEqual(expect.objectContaining({ fromLane: 1, toLane: 0 }));
    expect(rows[3]!.width).toBe(2);
  });

  it("gives a branch tip that nothing points at its own lane", () => {
    // Two branch tips, x on top of b and main at c, sharing history from b.
    const { rows } = layoutCommitGraph([commit("x", "b"), commit("c", "b"), commit("b")]);

    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0]);
    expect(rows[1]!.top).toContainEqual(expect.objectContaining({ fromLane: 0, toLane: 0 }));
    expect(rows[2]!.top).toContainEqual(expect.objectContaining({ fromLane: 1, toLane: 0 }));
  });

  it("keeps drawing a lane that a merge joins", () => {
    // x is a tip waiting on a; m then merges a in from the main line.
    const { rows } = layoutCommitGraph([
      commit("x", "a"),
      commit("m", "b", "a"),
      commit("b", "a"),
      commit("a"),
    ]);

    expect(rows[1]!.lane).toBe(1);
    expect(rows[1]!.bottom).toContainEqual(expect.objectContaining({ fromLane: 1, toLane: 0 }));
    expect(rows[1]!.bottom).toContainEqual(expect.objectContaining({ fromLane: 0, toLane: 0 }));
  });

  it("keeps each branch's colour along its lane", () => {
    const { rows } = layoutCommitGraph([
      commit("m", "b", "f"),
      commit("f", "a"),
      commit("b", "a"),
      commit("a"),
    ]);

    expect(rows[0]!.colorIndex).toBe(rows[2]!.colorIndex);
    expect(rows[1]!.colorIndex).not.toBe(rows[0]!.colorIndex);
  });
});
