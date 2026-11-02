import {
  WS_METHODS,
  type CompanyPanelAnswer,
  type CompanyPanelCostPoint,
  type CompanyPanelDecision,
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
  // The file only changes when a decision arrives, so an empty one that is days old is just calm.
  if (kind === "decisions" && "decisions" in section.data && section.data.decisions.length === 0) {
    return null;
  }
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

/** A, B, C… for an option's position on the card. */
export const companyDecisionOptionLetter = (index: number) => String.fromCharCode(65 + index);

export function companyDecisionOptionIndex(
  decision: Pick<CompanyPanelDecision, "options">,
  optionId: string | undefined,
): number | null {
  if (optionId === undefined) return null;
  const index = decision.options?.findIndex((option) => option.id === optionId) ?? -1;
  return index < 0 ? null : index;
}

export interface CompanyDecisionConsensus {
  /** Threads that picked an option. */
  readonly total: number;
  /** Threads behind the most-picked option. */
  readonly count: number;
  /** Null when there is a tie, so no option can be called the threads' choice. */
  readonly optionIndex: number | null;
}

/** What the "2 de 3 hilos recomiendan la opción A" seal says; null with no opinion to count. */
export function companyDecisionConsensus(
  decision: Pick<CompanyPanelDecision, "options" | "opinions">,
): CompanyDecisionConsensus | null {
  const votes = new Map<number, number>();
  for (const opinion of decision.opinions ?? []) {
    const index = companyDecisionOptionIndex(decision, opinion.optionId);
    if (index !== null) votes.set(index, (votes.get(index) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  const count = Math.max(...votes.values());
  const leaders = [...votes].filter(([, value]) => value === count);
  return {
    total: [...votes.values()].reduce((sum, value) => sum + value, 0),
    count,
    optionIndex: leaders.length === 1 ? (leaders[0]?.[0] ?? null) : null,
  };
}

export type CompanyDecisionSwipe = "right" | "left" | "up";

/**
 * What a swipe does. Yes-or-no cards: right yes, left no. With options, right takes the recommended
 * one and left the other when there are only two, so a swipe never picks an option nobody suggested.
 */
export function companyDecisionSwipeAction(
  decision: Pick<CompanyPanelDecision, "options">,
  swipe: CompanyDecisionSwipe,
): CompanyPanelAnswer | "write" | null {
  if (swipe === "up") return "write";
  const options = decision.options ?? [];
  if (options.length === 0) return { type: swipe === "right" ? "yes" : "no" };
  const recommended = options.find((option) => option.recommended);
  if (recommended === undefined) return null;
  if (swipe === "right") return { type: "option", optionId: recommended.id };
  const others = options.filter((option) => option !== recommended);
  const other = others.length === 1 ? others[0] : undefined;
  return other === undefined ? null : { type: "option", optionId: other.id };
}

/** "14:32", or "2 nov 14:32" when it is not from today. */
export function companyDecisionTime(createdAt: string, nowMs: number): string {
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(createdAt);
  const time = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  // @effect-diagnostics-next-line globalDate:off
  if (date.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${date.toLocaleDateString("es-ES", { day: "numeric", month: "short" })} ${time}`;
}

export type CompanyPanelTone = "good" | "warning" | "bad" | "active" | "neutral";

/** What a thread is doing, in plain words. */
export function companyThreadStatusView(status: string): {
  readonly label: string;
  readonly tone: CompanyPanelTone;
} {
  switch (status) {
    case "running":
    case "starting":
    case "preparing":
      return { label: "Trabajando", tone: "active" };
    case "waiting":
      return { label: "Espera una respuesta", tone: "warning" };
    case "queued":
      return { label: "En cola", tone: "warning" };
    case "failed":
      return { label: "Se ha parado por un fallo", tone: "bad" };
    case "interrupted":
    case "cancelled":
      return { label: "Interrumpido", tone: "warning" };
    default:
      return { label: "Libre", tone: "neutral" };
  }
}

export type CompanyPanelJobKind = "done" | "failed" | "warning" | "pending" | "skipped";

export const COMPANY_PANEL_JOB_KINDS: ReadonlyArray<{
  readonly kind: CompanyPanelJobKind;
  readonly label: string;
  readonly tone: CompanyPanelTone;
}> = [
  { kind: "failed", label: "Falla", tone: "bad" },
  { kind: "warning", label: "Con aviso", tone: "warning" },
  { kind: "pending", label: "Falta probar", tone: "active" },
  { kind: "skipped", label: "No aplica", tone: "neutral" },
  { kind: "done", label: "Hecho", tone: "good" },
];

export function companyPanelJobKind(job: CompanyPanelJob): CompanyPanelJobKind {
  if (job.result === "passed") return "done";
  if (job.result === "failed") return "failed";
  const { icon } = companyPanelJobState(job);
  if (icon.startsWith("⚠")) return "warning";
  if (icon === "⏳" || icon === "🔵") return "pending";
  return "skipped";
}

export type CompanyPanelJobTally = Readonly<Record<CompanyPanelJobKind, number>>;

export function companyPanelJobTally(jobs: ReadonlyArray<CompanyPanelJob>): CompanyPanelJobTally {
  const tally = { done: 0, failed: 0, warning: 0, pending: 0, skipped: 0 };
  for (const job of jobs) tally[companyPanelJobKind(job)] += 1;
  return tally;
}

/** Each battery with how it went, the ones with failures first. */
export function companyPanelSuites(jobs: ReadonlyArray<CompanyPanelJob>) {
  const suites = new Map<string, Array<CompanyPanelJob>>();
  for (const job of jobs) {
    const name = job.suite ?? "Sin batería";
    suites.set(name, [...(suites.get(name) ?? []), job]);
  }
  return [...suites]
    .map(([name, suiteJobs]) => ({
      name,
      total: suiteJobs.length,
      tally: companyPanelJobTally(suiteJobs),
    }))
    .sort((left, right) => right.tally.failed - left.tally.failed);
}

/** Failures first, so what is not done is what you see. */
export function companyPanelJobsByUrgency<J extends CompanyPanelJob>(jobs: ReadonlyArray<J>) {
  const order = COMPANY_PANEL_JOB_KINDS.map((entry) => entry.kind);
  return [...jobs].sort(
    (left, right) =>
      order.indexOf(companyPanelJobKind(left)) - order.indexOf(companyPanelJobKind(right)),
  );
}

/** The first sentence of a battery's long label. */
export const companyPanelShortLabel = (label: string) => label.split(/\.\s/)[0] ?? label;

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2 nov" from "2026-11-02"; anything else stays as it came. */
export function companyPanelShortDate(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  return match && month ? `${Number(match[2])} ${month}` : date;
}

/** What the cache number means for someone who has never heard of a cache. */
export function companyCacheView(percent: number): {
  readonly sentence: string;
  readonly tone: CompanyPanelTone;
} {
  const rounded = Math.round(percent);
  return {
    sentence: `De cada 100 palabras que lee el empleado, ${rounded} ya las tenía guardadas. Cuantas más, más barato.`,
    tone: percent >= 80 ? "good" : percent >= 50 ? "warning" : "bad",
  };
}

export const COMPANY_DATABASE_SENTENCE =
  "Lo que lee la base de datos en un día. Cuanto menos, más rápida va la app y menos cuesta.";

/** Against the level to stay under, when someone has set one; without it there is no verdict. */
export function companyDatabaseView(database: {
  readonly readGbPerDay: number;
  readonly targetGbPerDay?: number | undefined;
}): { readonly percent: number; readonly tone: CompanyPanelTone } | null {
  const { readGbPerDay, targetGbPerDay } = database;
  if (targetGbPerDay === undefined || targetGbPerDay <= 0) return null;
  const ratio = readGbPerDay / targetGbPerDay;
  return {
    percent: Math.min(ratio * 100, 100),
    tone: ratio <= 0.8 ? "good" : ratio <= 1 ? "warning" : "bad",
  };
}
