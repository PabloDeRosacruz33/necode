import {
  WS_METHODS,
  type CompanyPanelCostPoint,
  type CompanyPanelCostsFile,
  type CompanyPanelSnapshot,
  type CompanyPanelTestsFile,
} from "@t3tools/contracts";

import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Necode: the company panel's data; viewers refresh it while the panel is open. */
export function createCompanyPanelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:company-panel:snapshot",
      tag: WS_METHODS.companyPanelSnapshot,
      staleTimeMs: 0,
      idleTtlMs: 60_000,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-panel:answer",
      tag: WS_METHODS.companyPanelAnswer,
    }),
  };
}

export const COMPANY_PANEL_REFRESH_MS = 30_000;

export interface CostSimulation {
  readonly people: number;
  readonly volume: number;
  /** Fifths of that day's images, 1 to 5. */
  readonly imageFifths: number;
}

/** The "what if" of rule D205: monthly cost for that many people. */
export function simulateMonthlyCost(
  simulator: NonNullable<CompanyPanelCostsFile["simulator"]>,
  simulation: CostSimulation,
): number {
  const scale = simulation.volume / simulator.baseVolume;
  const perPerson =
    (simulator.withoutImages + simulator.perFifthOfImages * simulation.imageFifths) * scale;
  return perPerson * simulation.people;
}

export interface CostTrend {
  readonly latest: CompanyPanelCostPoint;
  /** Change since the first point, in percent. Null with a single point. */
  readonly sinceStartPercent: number | null;
  /** Change since the point before the latest: what the last recalculation moved. */
  readonly sinceLast: { readonly amount: number; readonly date: string } | null;
}

export function costTrend(points: ReadonlyArray<CompanyPanelCostPoint>): CostTrend | null {
  const latest = points.at(-1);
  if (latest === undefined) return null;
  const first = points[0];
  const previous = points.at(-2);
  return {
    latest,
    sinceStartPercent:
      points.length > 1 && first !== undefined && first.total > 0
        ? ((latest.total - first.total) / first.total) * 100
        : null,
    sinceLast:
      previous === undefined
        ? null
        : { amount: latest.total - previous.total, date: previous.date },
  };
}

export const pendingCompanyDecisions = (snapshot: CompanyPanelSnapshot) =>
  snapshot.decisions.status === "ok" ? snapshot.decisions.data.decisions : [];

export type CompanyPanelDataKind = "decisions" | "costs" | "health" | "tests";

const HOUR_MS = 3_600_000;

/**
 * How old each file may get before it reads as old, about two missed publications. Health is
 * rewritten every hour; costs and tests with each release, which can pause over a quiet day;
 * decisions only change when someone adds one.
 */
export const COMPANY_PANEL_MAX_AGE_MS: Record<CompanyPanelDataKind, number> = {
  health: 3 * HOUR_MS,
  costs: 48 * HOUR_MS,
  tests: 48 * HOUR_MS,
  decisions: 72 * HOUR_MS,
};

/** "Viejo · hace 5 h" when a file stopped being published, so it does not pass for current. */
export function companyPanelStaleLabel(
  kind: CompanyPanelDataKind,
  section: CompanyPanelSnapshot["health" | "costs" | "tests" | "decisions"],
  nowMs: number,
): string | null {
  if (section.status !== "ok") return null;
  const age = nowMs - Date.parse(section.updatedAt);
  if (!Number.isFinite(age) || age <= COMPANY_PANEL_MAX_AGE_MS[kind]) return null;
  const hours = Math.floor(age / HOUR_MS);
  return `Viejo · hace ${hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} días`}`;
}

type CompanyPanelJob = NonNullable<CompanyPanelTestsFile["jobs"]>[number];

const RESULT_ICON: Record<CompanyPanelJob["result"], string> = {
  passed: "✅",
  failed: "❌",
  skipped: "⚪",
};

/**
 * A job's state as its publisher wrote it. The file's result only has three values, so the finer
 * ones (⚠️ warning, ⏳ waiting for a real test, 🔵 in progress) travel first in `now`.
 */
export function companyPanelJobState(job: CompanyPanelJob): {
  readonly icon: string;
  readonly note: string | null;
} {
  const match = /^\s*(\p{Extended_Pictographic}\uFE0F?)\s*(.*)$/su.exec(job.now ?? "");
  if (match?.[1] !== undefined) {
    const note = match[2]?.trim() ?? "";
    return { icon: match[1], note: note === "" ? null : note };
  }
  const now = job.now?.trim() ?? "";
  return { icon: RESULT_ICON[job.result], note: now === "" ? null : now };
}
