import { describe, expect, it } from "@effect/vitest";

import {
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
