import { describe, expect, it } from "@effect/vitest";

import {
  companyTestsVersionHeading,
  companyErrorDays,
  companyTestStateLabel,
  companyDatabaseIsStale,
  companyTestsByVersion,
  companyThreadTile,
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

  it("gives no verdict on the database without a level to compare with", () => {
    expect(companyDatabaseView({ readGbPerDay: 455 })).toBeNull();
    expect(companyDatabaseView({ readGbPerDay: 50, targetGbPerDay: 100 })?.tone).toBe("good");
    expect(companyDatabaseView({ readGbPerDay: 150, targetGbPerDay: 100 })?.tone).toBe("bad");
  });
});

describe("companyThreadTile", () => {
  const nowMs = Date.parse("2026-11-02T20:00:00.000Z");
  const tile = (thread: object, decisionThreads: ReadonlyArray<string> = []) =>
    companyThreadTile(
      { name: "AutoBug", status: "idle", ...thread },
      { nowMs, decisionThreads: new Set(decisionThreads) },
    );

  it("only calls a thread working if it did something lately", () => {
    expect(tile({ status: "running", lastActivityAt: "2026-11-02T19:55:00.000Z" }).tone).toBe(
      "working",
    );
    const silent = tile({ status: "running", lastActivityAt: "2026-11-02T19:30:00.000Z" });
    expect(silent.tone).toBe("idle");
    expect(silent.state).toBe("Dice que trabaja; sin señal hace 30 min");
    expect(tile({ status: "running" }).tone).toBe("idle");
  });

  it("does not take a finished turn with background commands as work", () => {
    const tileView = tile({ status: "completed", backgroundCommands: 2 });
    expect(tileView.tone).toBe("idle");
    expect(tileView.caveat).toContain("sin confirmar");
  });

  it("shows a failure first, then a decision", () => {
    expect(tile({ status: "failed" }, ["AutoBug"]).tone).toBe("failed");
    expect(tile({ status: "completed" }, ["AutoBug"]).tone).toBe("decision");
  });

  it("ignores the coordinator's note for the colour", () => {
    expect(tile({ status: "completed", phrase: "Trabajando sin parar" }).tone).toBe("idle");
  });
});

describe("companyTestsByVersion", () => {
  const run = (version: string, result: "passed" | "failed", at = "2026-11-01T10:00:00.000Z") => ({
    version,
    result,
    at,
  });
  const test = (id: string, runs: ReadonlyArray<ReturnType<typeof run>>) => ({
    id,
    suite: "Microsoft",
    message: id,
    runs,
  });
  const file = (tests: ReadonlyArray<ReturnType<typeof test>>) => ({
    label: "x",
    passed: 0,
    failed: 0,
    skipped: 0,
    currentVersion: "2.0.22",
    tests,
  });

  it("has nothing to say until the data can be split by version", () => {
    expect(companyTestsByVersion({ label: "x", passed: 41, failed: 1, skipped: 7 })).toBeNull();
  });

  it("never counts a run from another version", () => {
    const view = companyTestsByVersion(
      file([
        test("hoy", [run("2.0.22", "passed")]),
        test("antigua", [run("2.0.12", "passed")]),
        test("nunca", []),
      ]),
    );
    expect(view?.tally).toEqual({ passed: 1, failed: 0, warning: 0, untested: 2 });
    const old = view?.rows.find((row) => row.id === "antigua");
    expect(old?.state).toBe("untested");
    expect(old?.previous).toEqual({ version: "2.0.12", result: "passed" });
  });

  it("takes the latest run of the version, and puts what is not done first", () => {
    const view = companyTestsByVersion(
      file([
        test("ok", [run("2.0.22", "passed")]),
        test("arreglada", [
          run("2.0.22", "failed", "2026-11-01T10:00:00.000Z"),
          run("2.0.22", "passed", "2026-11-02T10:00:00.000Z"),
        ]),
        test("mal", [run("2.0.22", "failed")]),
      ]),
    );
    expect(view?.rows[0]?.id).toBe("mal");
    expect(view?.rows.find((row) => row.id === "arreglada")?.state).toBe("passed");
    expect(view?.rows.find((row) => row.id === "arreglada")?.history).toEqual(["failed", "passed"]);
  });
});

describe("companyDatabaseIsStale", () => {
  it("allows for measures taken every few minutes", () => {
    const now = Date.parse("2026-11-02T20:30:00.000Z");
    expect(companyDatabaseIsStale("2026-11-02T20:10:00.000Z", now)).toBe(false);
    expect(companyDatabaseIsStale("2026-11-02T20:00:00.000Z", now)).toBe(true);
  });
});

describe("companyTestStateLabel", () => {
  const row = {
    id: "x",
    suite: "s",
    message: "m",
    why: null,
    history: [],
  };

  it("says when a test only ran in another version", () => {
    expect(
      companyTestStateLabel({
        ...row,
        state: "untested",
        previous: { version: "2.0.12", result: "passed" },
      }),
    ).toBe("Sin probar en esta versión · bien en 2.0.12");
    expect(companyTestStateLabel({ ...row, state: "untested", previous: null })).toBe(
      "Sin probar nunca",
    );
  });
});

describe("companyErrorDays", () => {
  it("keeps 15 days and does not call an old figure today's", () => {
    const days = Array.from({ length: 20 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      count: index,
    }));
    const now = Date.parse("2026-10-20T12:00:00");
    expect(companyErrorDays(days, now).days).toHaveLength(15);
    expect(companyErrorDays(days, now).latestIsToday).toBe(true);
    expect(companyErrorDays(days, Date.parse("2026-10-22T12:00:00")).latestIsToday).toBe(false);
  });
});

describe("companyTestsVersionHeading", () => {
  const versions = [
    { environment: "Staging", version: "26c36c720" },
    { environment: "App de Mac", version: "2.0.22" },
  ];

  it("names a commit as the Cloud's, with the app's version beside it", () => {
    expect(companyTestsVersionHeading("26c36c720", versions)).toEqual({
      title: "Cloud 26c36c720",
      app: "App de Mac 2.0.22",
    });
  });

  it("keeps a plain version as it is, and has no app without the data", () => {
    expect(companyTestsVersionHeading("2.0.22", [])).toEqual({
      title: "Versión 2.0.22",
      app: null,
    });
  });
});
