import {
  WS_METHODS,
  type CompanyPanelCostPoint,
  type CompanyPanelCostsFile,
  type CompanyPanelSnapshot,
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
