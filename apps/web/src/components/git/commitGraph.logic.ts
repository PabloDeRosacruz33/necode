/**
 * Lane layout for the Git panel's commit graph.
 *
 * Commits arrive newest first in topological order, so every child is placed
 * before its parents. Each lane remembers the commit it is waiting for; a
 * commit takes the lane waiting for it (or a free one), sends its first parent
 * down the same lane and opens or joins lanes for any other parents. Lanes are
 * never compacted, so a branch keeps its column for as long as it runs.
 */

export interface GraphCommitInput {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
}

/** A line drawn in one half of a row, between lane columns. */
export interface GraphSegment {
  readonly fromLane: number;
  readonly toLane: number;
  readonly colorIndex: number;
}

export interface GraphRow {
  readonly lane: number;
  readonly colorIndex: number;
  /** From the top edge of the row to the node's height. */
  readonly top: ReadonlyArray<GraphSegment>;
  /** From the node's height to the bottom edge of the row. */
  readonly bottom: ReadonlyArray<GraphSegment>;
  /** Columns this row needs, counting lanes that only pass through it. */
  readonly width: number;
}

export interface CommitGraphLayout {
  readonly rows: ReadonlyArray<GraphRow>;
  readonly maxWidth: number;
}

interface Lane {
  readonly sha: string;
  readonly colorIndex: number;
}

export function layoutCommitGraph(commits: ReadonlyArray<GraphCommitInput>): CommitGraphLayout {
  const lanes: Array<Lane | null> = [];
  let nextColor = 0;
  let maxWidth = 0;
  const rows: GraphRow[] = [];

  const freeLane = (from = 0) => {
    for (let index = from; index < lanes.length; index++) {
      if (lanes[index] === null) return index;
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const waiting = lanes.flatMap((lane, index) => (lane?.sha === commit.sha ? [index] : []));
    const lane = waiting[0] ?? freeLane();
    const colorIndex = lanes[lane]?.colorIndex ?? nextColor++;

    const top: GraphSegment[] = [];
    lanes.forEach((entry, index) => {
      if (entry === null) return;
      top.push({
        fromLane: index,
        toLane: entry.sha === commit.sha ? lane : index,
        colorIndex: entry.colorIndex,
      });
    });
    for (const index of waiting) lanes[index] = null;

    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent === undefined ? null : { sha: firstParent, colorIndex };
    const bottom: GraphSegment[] = [];
    const openedLanes = new Set<number>();
    if (firstParent !== undefined) bottom.push({ fromLane: lane, toLane: lane, colorIndex });
    for (const parent of otherParents) {
      const existing = lanes.findIndex((entry) => entry?.sha === parent);
      if (existing >= 0) {
        bottom.push({ fromLane: lane, toLane: existing, colorIndex: lanes[existing]!.colorIndex });
        continue;
      }
      const opened = freeLane(lane + 1);
      const parentColor = nextColor++;
      lanes[opened] = { sha: parent, colorIndex: parentColor };
      openedLanes.add(opened);
      bottom.push({ fromLane: lane, toLane: opened, colorIndex: parentColor });
    }
    lanes.forEach((entry, index) => {
      // A lane opened here starts at the node; every other one carries on straight down.
      if (entry === null || index === lane || openedLanes.has(index)) return;
      bottom.push({ fromLane: index, toLane: index, colorIndex: entry.colorIndex });
    });

    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
    const width =
      Math.max(
        lane,
        ...top.map((segment) => Math.max(segment.fromLane, segment.toLane)),
        ...bottom.map((segment) => Math.max(segment.fromLane, segment.toLane)),
      ) + 1;
    maxWidth = Math.max(maxWidth, width);
    rows.push({ lane, colorIndex, top, bottom, width });
  }

  return { rows, maxWidth };
}
