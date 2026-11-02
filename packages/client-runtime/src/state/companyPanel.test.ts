import { describe, expect, it } from "@effect/vitest";

import { costTrend, simulateMonthlyCost } from "./companyPanel.ts";

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
