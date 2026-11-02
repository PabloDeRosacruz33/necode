import { describe, expect, it } from "@effect/vitest";

import {
  companyCacheView,
  companyDatabaseView,
  companyPanelJobKind,
  companyPanelJobsByUrgency,
  companyPanelShortDate,
  companyPanelSuites,
  companyDecisionConsensus,
  companyDecisionSwipeAction,
  companyPanelJobState,
  companyPanelStaleLabel,
  costTrend,
  simulateMonthlyCost,
} from "./companyPanel.ts";

const point = (date: string, total: number) => ({ date, total, parts: [] });

describe("simulateMonthlyCost", () => {
  const simulator = { withoutImages: 121, perFifthOfImages: 14, baseVolume: 2.5 };

  it("gives the rule's cost at its base values", () => {
    expect(simulateMonthlyCost(simulator, { people: 1, volume: 2.5, imageFifths: 1 })).toBe(135);
  });

  it("scales with people, volume and images", () => {
    expect(simulateMonthlyCost(simulator, { people: 10, volume: 2.5, imageFifths: 1 })).toBe(1350);
    expect(simulateMonthlyCost(simulator, { people: 1, volume: 5, imageFifths: 1 })).toBe(270);
    expect(simulateMonthlyCost(simulator, { people: 1, volume: 2.5, imageFifths: 5 })).toBe(191);
  });
});

describe("costTrend", () => {
  it("has no trend without data, rather than a zero", () => {
    expect(costTrend([])).toBeNull();
  });

  it("says what changed since the start and since the last recalculation", () => {
    const trend = costTrend([point("24-oct", 200), point("31-oct", 150), point("1-nov", 100)]);
    expect(trend?.sinceStartPercent).toBe(-50);
    expect(trend?.sinceLast).toEqual({ amount: -50, date: "31-oct" });
  });

  it("has no change to tell with a single point", () => {
    const trend = costTrend([point("24-oct", 200)]);
    expect(trend?.sinceStartPercent).toBeNull();
    expect(trend?.sinceLast).toBeNull();
  });
});

describe("companyPanelStaleLabel", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const section = (updatedAt: string) => ({
    status: "ok" as const,
    updatedAt,
    data: { versions: [], systems: [] },
  });

  it("leaves data within its age alone", () => {
    expect(companyPanelStaleLabel("health", section("2026-11-02T10:00:00.000Z"), now)).toBeNull();
  });

  it("marks data a publisher stopped writing", () => {
    expect(companyPanelStaleLabel("health", section("2026-11-02T07:00:00.000Z"), now)).toBe(
      "Viejo · hace 5 h",
    );
    expect(companyPanelStaleLabel("costs", section("2026-10-29T12:00:00.000Z"), now)).toBe(
      "Viejo · hace 4 días",
    );
  });

  it("has nothing to say about data that is not there", () => {
    expect(companyPanelStaleLabel("health", { status: "missing" }, now)).toBeNull();
  });
});

describe("companyPanelJobState", () => {
  const job = (result: "passed" | "failed" | "skipped", now?: string) => ({
    message: "m",
    result,
    ...(now === undefined ? {} : { now }),
  });

  it("reads the finer states publishers put first in now", () => {
    expect(companyPanelJobState(job("skipped", "⚠️"))).toEqual({ icon: "⚠️", note: null });
    expect(companyPanelJobState(job("skipped", "⏳ se verá en la próxima caída"))).toEqual({
      icon: "⏳",
      note: "se verá en la próxima caída",
    });
    expect(companyPanelJobState(job("skipped", "🔵"))).toEqual({ icon: "🔵", note: null });
  });

  it("falls back to the result", () => {
    expect(companyPanelJobState(job("passed"))).toEqual({ icon: "✅", note: null });
    expect(companyPanelJobState(job("skipped", "sin probar"))).toEqual({
      icon: "⚪",
      note: "sin probar",
    });
  });
});

describe("companyDecisionConsensus", () => {
  const options = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];
  const opinion = (optionId?: string) => ({
    thread: "t",
    opinion: "o",
    ...(optionId === undefined ? {} : { optionId }),
  });

  it("names the option most threads picked", () => {
    expect(
      companyDecisionConsensus({ options, opinions: [opinion("a"), opinion("a"), opinion("b")] }),
    ).toEqual({ total: 3, count: 2, optionIndex: 0 });
  });

  it("names no option on a tie", () => {
    expect(
      companyDecisionConsensus({ options, opinions: [opinion("a"), opinion("b")] })?.optionIndex,
    ).toBeNull();
  });

  it("has no seal without opinions on an option", () => {
    expect(companyDecisionConsensus({ options })).toBeNull();
    expect(companyDecisionConsensus({ options, opinions: [opinion()] })).toBeNull();
    expect(companyDecisionConsensus({ options, opinions: [opinion("gone")] })).toBeNull();
  });
});

describe("companyDecisionSwipeAction", () => {
  const a = { id: "a", label: "A", recommended: true };
  const b = { id: "b", label: "B" };
  const c = { id: "c", label: "C" };

  it("answers yes or no on cards without options", () => {
    expect(companyDecisionSwipeAction({}, "right")).toEqual({ type: "yes" });
    expect(companyDecisionSwipeAction({}, "left")).toEqual({ type: "no" });
  });

  it("takes the recommended option right, and the other left only when there are two", () => {
    expect(companyDecisionSwipeAction({ options: [b, a] }, "right")).toEqual({
      type: "option",
      optionId: "a",
    });
    expect(companyDecisionSwipeAction({ options: [a, b] }, "left")).toEqual({
      type: "option",
      optionId: "b",
    });
    expect(companyDecisionSwipeAction({ options: [a, b, c] }, "left")).toBeNull();
  });

  it("never picks for the person when nothing is recommended", () => {
    expect(companyDecisionSwipeAction({ options: [b, c] }, "right")).toBeNull();
    expect(companyDecisionSwipeAction({ options: [b, c] }, "up")).toBe("write");
  });
});

describe("companyPanelStaleLabel with decisions", () => {
  it("does not call an empty list old", () => {
    const now = Date.parse("2026-11-10T12:00:00.000Z");
    const section = (decisions: ReadonlyArray<never>) => ({
      status: "ok" as const,
      updatedAt: "2026-11-02T12:00:00.000Z",
      data: { decisions },
    });
    expect(companyPanelStaleLabel("decisions", section([]), now)).toBeNull();
  });
});

describe("job kinds", () => {
  const job = (result: "passed" | "failed" | "skipped", now?: string, suite?: string) => ({
    message: `${result}${now ?? ""}`,
    result,
    ...(now === undefined ? {} : { now }),
    ...(suite === undefined ? {} : { suite }),
  });

  it("reads the finer states publishers keep inside skipped", () => {
    expect(companyPanelJobKind(job("skipped", "⚠️"))).toBe("warning");
    expect(companyPanelJobKind(job("skipped", "⏳ falta prueba"))).toBe("pending");
    expect(companyPanelJobKind(job("skipped", "🔵"))).toBe("pending");
    expect(companyPanelJobKind(job("skipped"))).toBe("skipped");
    expect(companyPanelJobKind(job("passed", "✅"))).toBe("done");
  });

  it("puts what is not done first", () => {
    const sorted = companyPanelJobsByUrgency([job("passed"), job("failed"), job("skipped", "⏳")]);
    expect(sorted.map((entry) => companyPanelJobKind(entry))).toEqual([
      "failed",
      "pending",
      "done",
    ]);
  });

  it("counts each battery, failures first", () => {
    const suites = companyPanelSuites([
      job("passed", undefined, "A"),
      job("failed", undefined, "B"),
      job("passed", undefined, "B"),
    ]);
    expect(suites.map((suite) => [suite.name, suite.total, suite.tally.failed])).toEqual([
      ["B", 2, 1],
      ["A", 1, 0],
    ]);
  });
});

describe("plain views", () => {
  it("shortens dates and leaves the rest alone", () => {
    expect(companyPanelShortDate("2026-11-02")).toBe("2 nov");
    expect(companyPanelShortDate("ayer")).toBe("ayer");
  });

  it("explains the cache in plain words", () => {
    expect(companyCacheView(96.2).sentence).toContain("96");
    expect(companyCacheView(96.2).tone).toBe("good");
    expect(companyCacheView(30).tone).toBe("bad");
  });

  it("gives no verdict on the database without a level to compare with", () => {
    expect(companyDatabaseView({ readGbPerDay: 455 })).toBeNull();
    expect(companyDatabaseView({ readGbPerDay: 50, targetGbPerDay: 100 })?.tone).toBe("good");
    expect(companyDatabaseView({ readGbPerDay: 150, targetGbPerDay: 100 })?.tone).toBe("bad");
  });
});
