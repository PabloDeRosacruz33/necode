import {
  WS_METHODS,
  type CompanyPanelAnswer,
  type CompanyPanelCostPoint,
  type CompanyPanelDecision,
  type CompanyPanelCostsFile,
  type CompanyPanelSnapshot,
  type CompanyPanelPlan,
  type CompanyPanelPlanSquareStatus,
  type CompanyPanelTest,
  type CompanyPanelTestResult,
  type CompanyPanelTestsFile,
  type CompanyPanelThreadActivity,
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

export type CompanyPanelDataKind = "decisions" | "costs" | "health" | "tests" | "plans";

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
  plans: 72 * HOUR_MS,
};

/** "Viejo · hace 5 h" when a file stopped being published, so it does not pass for current. */
export function companyPanelStaleLabel(
  kind: CompanyPanelDataKind,
  section: NonNullable<CompanyPanelSnapshot["health" | "costs" | "tests" | "decisions" | "plans"]>,
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

/** The count behind the "2 de 3 hilos eligen…" seal; null with no opinion on an option. */
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

/** The seal's sentence, or null when no thread has given an opinion, which must show as missing. */
export function companyDecisionSealText(
  decision: Pick<CompanyPanelDecision, "options" | "opinions">,
): string | null {
  const consensus = companyDecisionConsensus(decision);
  if (consensus === null) {
    const opinions = decision.opinions?.length ?? 0;
    return opinions === 0 ? null : `${opinions} hilos han opinado sin elegir opción`;
  }
  const option =
    consensus.optionIndex === null ? undefined : decision.options?.[consensus.optionIndex];
  return option === undefined
    ? `Los hilos no se ponen de acuerdo (${consensus.total})`
    : `${consensus.count} de ${consensus.total} hilos eligen «${option.label}»`;
}

export interface CompanyDecisionMatrixRow {
  readonly key: string;
  readonly name: string;
  /** The column it marks; null when it gave a reason without picking an option. */
  readonly optionId: string | null;
  readonly reason: string;
  readonly source: string | null;
}

/**
 * Who picks what, opened from the seal: one column per option, one row per thread or product, and
 * where each row's reason and source live. Picks of options that no longer exist mark no column.
 */
export function companyDecisionMatrix(
  decision: Pick<CompanyPanelDecision, "options" | "opinions" | "references">,
) {
  const options = decision.options ?? [];
  const pick = (optionId: string | undefined) =>
    options.some((option) => option.id === optionId) ? (optionId ?? null) : null;
  const threads = (decision.opinions ?? []).map((opinion, index): CompanyDecisionMatrixRow => ({
    key: `thread:${index}`,
    name: opinion.thread,
    optionId: pick(opinion.optionId),
    reason: opinion.opinion,
    source: null,
  }));
  const others = (decision.references ?? []).map((reference, index): CompanyDecisionMatrixRow => ({
    key: `other:${index}`,
    name: reference.name,
    optionId: pick(reference.optionId),
    reason: reference.how,
    source: reference.source ?? null,
  }));
  return {
    columns: options.map((option) => ({
      id: option.id,
      label: option.short ?? option.label,
      recommended: option.recommended === true,
      total: [...threads, ...others].filter((row) => row.optionId === option.id).length,
    })),
    threads,
    others,
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
/** Against the level to stay under, when someone has set one; without it there is no verdict. */
export function companyDatabaseView(database: {
  readonly readGbPerDay: number;
  readonly targetGbPerDay?: number | undefined;
}): {
  readonly percent: number;
  readonly percentOfWarning: number;
  readonly tone: CompanyPanelTone;
} | null {
  const { readGbPerDay, targetGbPerDay } = database;
  if (targetGbPerDay === undefined || targetGbPerDay <= 0) return null;
  const ratio = readGbPerDay / targetGbPerDay;
  return {
    percent: Math.min(ratio * 100, 100),
    percentOfWarning: Math.round(ratio * 100),
    tone: ratio <= 0.8 ? "good" : ratio <= 1 ? "warning" : "bad",
  };
}

// Fixed colours where the approved design needs more than the theme's tones.
export const COMPANY_PANEL_COLORS = {
  working: "#2f7fe0",
  decision: "#8b5cf6",
  idle: "#7b8088",
  failed: "#e5484d",
  /** A thread or test outside every plan. */
  noPlan: "#475569",
  parts: ["#346bf1", "#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
} as const;

const SILENT_AFTER_MS = 15 * 60_000;

export type CompanyThreadTone = "working" | "decision" | "idle" | "failed";

/** The band on a thread's tile, in a colour no plan may use, so state and plan never mix up. */
export const COMPANY_THREAD_TONES: Record<
  CompanyThreadTone,
  { readonly color: string; readonly icon: string; readonly label: string }
> = {
  working: { color: COMPANY_PANEL_COLORS.working, icon: "▶\uFE0E", label: "Trabajando" },
  decision: { color: COMPANY_PANEL_COLORS.decision, icon: "?", label: "Tu decisión" },
  idle: { color: COMPANY_PANEL_COLORS.idle, icon: "Ⅱ", label: "Parado" },
  failed: { color: COMPANY_PANEL_COLORS.failed, icon: "!", label: "Fallo" },
};

export const companyPanelPlans = (snapshot: CompanyPanelSnapshot) =>
  snapshot.plans?.status === "ok" ? snapshot.plans.data.plans : [];

/** A plan's colour, or the no-plan one if the file's is not "#rrggbb". */
export const companyPlanColor = (color: string) =>
  /^#[0-9a-f]{6}$/i.test(color) ? color : COMPANY_PANEL_COLORS.noPlan;

/** The squares inside a plan: filled colours that read at a glance, with no text to go through. */
export const COMPANY_PLAN_SQUARES: Record<
  CompanyPanelPlanSquareStatus,
  { readonly color: string; readonly icon: string; readonly label: string }
> = {
  ok: { color: "#15803d", icon: "✓", label: "Bien" },
  bad: { color: "#dc2626", icon: "✕", label: "Mal" },
  decide: { color: "#6d4fc4", icon: "?", label: "Por decidir" },
  partial: { color: "#64748b", icon: "…", label: "A medias" },
};

/** A plan's "Te toca" for this person; someone else's turn is not theirs to see. */
export function companyPlanTurn(
  plan: Pick<CompanyPanelPlan, "yourTurn">,
  person: string | null,
): string | null {
  const turn = plan.yourTurn;
  if (turn === undefined) return null;
  if (turn.people !== undefined && (person === null || !turn.people.includes(person))) return null;
  return `Te toca: ${turn.text}`;
}

/** The plan a thread paints with; threads outside every plan are the system's. */
export function companyThreadPlan(
  threadName: string,
  plans: ReadonlyArray<CompanyPanelPlan>,
): { readonly name: string; readonly color: string } {
  const plan = plans.find((candidate) => candidate.threads?.includes(threadName));
  return plan
    ? { name: plan.name, color: companyPlanColor(plan.color) }
    : { name: "Sistema", color: COMPANY_PANEL_COLORS.noPlan };
}

/**
 * A thread's tile. Its colour only comes from what the server sees, never from the coordinator's
 * note: blue needs a turn in progress that actually produced something lately, because a turn can
 * say running with its process dead, and "finished" says nothing of commands left in the background.
 * `caveat` is what the colour alone does not tell.
 */
export function companyThreadTile(
  thread: CompanyPanelThreadActivity,
  input: { readonly nowMs: number; readonly decisionThreads: ReadonlySet<string> },
): {
  readonly tone: CompanyThreadTone;
  readonly state: string;
  readonly caveat: string | null;
} {
  const view = companyThreadStatusView(thread.status);
  if (view.tone === "bad") return { tone: "failed", state: view.label, caveat: null };
  if (input.decisionThreads.has(thread.name)) {
    return { tone: "decision", state: "Tu decisión", caveat: null };
  }
  if (view.tone === "active") {
    const last = thread.lastActivityAt ? Date.parse(thread.lastActivityAt) : Number.NaN;
    const silentMs = input.nowMs - last;
    if (Number.isFinite(silentMs) && silentMs <= SILENT_AFTER_MS) {
      return { tone: "working", state: "Trabajando", caveat: null };
    }
    const state = Number.isFinite(silentMs)
      ? `Dice que trabaja; sin señal hace ${Math.round(silentMs / 60_000)} min`
      : "Dice que trabaja; sin señal";
    return { tone: "idle", state, caveat: state };
  }
  if ((thread.backgroundCommands ?? 0) > 0) {
    const state = "Terminó su turno; comandos en segundo plano sin confirmar";
    return { tone: "idle", state, caveat: state };
  }
  return view.tone === "warning"
    ? { tone: "idle", state: view.label, caveat: view.label }
    : { tone: "idle", state: "Parado", caveat: null };
}

/** "hace 3 min", for data that is measured every few minutes rather than live. */
export function companyPanelAgo(at: string, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(at)) / 60_000));
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} días`;
}

const DATABASE_STALE_MS = 25 * 60_000;

/** Whether a database measure is too old to read as the current state. */
export const companyDatabaseIsStale = (checkedAt: string, nowMs: number) =>
  nowMs - Date.parse(checkedAt) > DATABASE_STALE_MS;

export type CompanyTestState = CompanyPanelTestResult | "untested";

export interface CompanyTestRow {
  readonly id: string;
  readonly suite: string;
  readonly message: string;
  readonly plan: string | null;
  /** Its state in the current version; "untested" if it has not run in it. */
  readonly state: CompanyTestState;
  readonly why: string | null;
  /** The newest run in another version, shown apart and never counted. */
  readonly previous: { readonly version: string; readonly result: CompanyPanelTestResult } | null;
  /** Every run, oldest first: the test's evolution across versions. */
  readonly history: ReadonlyArray<CompanyPanelTestResult>;
}

export interface CompanyTestTally {
  readonly passed: number;
  readonly failed: number;
  readonly warning: number;
  /** Not run in this version, or run without a verdict. */
  readonly untested: number;
}

const tallyOf = (rows: ReadonlyArray<CompanyTestRow>): CompanyTestTally => ({
  passed: rows.filter((row) => row.state === "passed").length,
  failed: rows.filter((row) => row.state === "failed").length,
  warning: rows.filter((row) => row.state === "warning").length,
  untested: rows.filter(
    (row) => row.state === "untested" || row.state === "pending" || row.state === "skipped",
  ).length,
});

const TEST_STATE_ORDER: ReadonlyArray<CompanyTestState> = [
  "failed",
  "warning",
  "pending",
  "untested",
  "skipped",
  "passed",
];

/**
 * The tests against the current version only: a run from another version never counts. Null until
 * the publisher gives both the version and the tests, since older data cannot be split by version.
 */
export function companyTestsByVersion(file: CompanyPanelTestsFile) {
  const { currentVersion, tests } = file;
  if (currentVersion === undefined || tests === undefined) return null;
  const rows = tests.map((test: CompanyPanelTest): CompanyTestRow => {
    const runs = [...test.runs].sort((left, right) => left.at.localeCompare(right.at));
    const current = runs.filter((run) => run.version === currentVersion).at(-1);
    const previous = runs.filter((run) => run.version !== currentVersion).at(-1);
    return {
      id: test.id,
      suite: test.suite,
      message: test.message,
      plan: test.plan ?? null,
      state: current?.result ?? "untested",
      why: current?.why ?? null,
      previous: previous ? { version: previous.version, result: previous.result } : null,
      history: runs.map((run) => run.result),
    };
  });
  const suites = [...new Set(rows.map((row) => row.suite))].map((name) => ({
    name,
    tally: tallyOf(rows.filter((row) => row.suite === name)),
  }));
  return {
    version: currentVersion,
    tally: tallyOf(rows),
    suites,
    rows: [...rows].sort(
      (left, right) => TEST_STATE_ORDER.indexOf(left.state) - TEST_STATE_ORDER.indexOf(right.state),
    ),
  };
}

/**
 * The heading of the version tests count against. The Cloud only reports its commit, which alone
 * reads like a fault, so it is named as what it is and the app's version goes beside it.
 */
export function companyTestsVersionHeading(
  version: string,
  versions: ReadonlyArray<{ readonly environment: string; readonly version: string }>,
): { readonly title: string; readonly app: string | null } {
  const app = versions.find((entry) => /\bapp\b/i.test(entry.environment));
  return {
    title: /^[0-9a-f]{7,40}$/.test(version) ? `Cloud ${version}` : `Versión ${version}`,
    app: app ? `${app.environment} ${app.version}` : null,
  };
}

/**
 * One row per plan, with the tests of each. A plan without tests stays, because that is worth
 * seeing; tests with no plan or an unknown one go in a last row, so that none silently disappears.
 */
export function companyTestsByPlan(
  rows: ReadonlyArray<CompanyTestRow>,
  plans: ReadonlyArray<CompanyPanelPlan>,
) {
  const known = new Set(plans.map((plan) => plan.id));
  const group = (id: string, name: string, color: string, inGroup: typeof rows) => ({
    id,
    name,
    color,
    rows: inGroup,
    tally: tallyOf(inGroup),
  });
  const outside = rows.filter((row) => row.plan === null || !known.has(row.plan));
  return [
    ...plans.map((plan) =>
      group(
        plan.id,
        plan.name,
        companyPlanColor(plan.color),
        rows.filter((row) => row.plan === plan.id),
      ),
    ),
    ...(outside.length > 0 ? [group("", "Sin plan", COMPANY_PANEL_COLORS.noPlan, outside)] : []),
  ];
}

/** "2 de Memoria, 1 de DevOps", or null when that day's split is not known. */
export function companyErrorsByPlanText(
  day: {
    readonly byPlan?: ReadonlyArray<{ readonly plan: string; readonly count: number }> | undefined;
  },
  plans: ReadonlyArray<CompanyPanelPlan>,
): string | null {
  if (day.byPlan === undefined) return null;
  return day.byPlan
    .map(
      (entry) =>
        `${entry.count} de ${plans.find((plan) => plan.id === entry.plan)?.name ?? entry.plan}`,
    )
    .join(", ");
}

/** Plain words for a test's state in the current version, and for its last run elsewhere. */
export function companyTestStateLabel(row: CompanyTestRow): string {
  switch (row.state) {
    case "passed":
      return "Bien";
    case "failed":
      return "Falla";
    case "warning":
      return "Con aviso";
    case "pending":
      return "Pendiente";
    case "skipped":
      return "Sin resultado";
    case "untested": {
      if (row.previous === null) return "Sin probar nunca";
      const verdict: Record<CompanyPanelTestResult, string> = {
        passed: "bien",
        failed: "falló",
        warning: "con aviso",
        pending: "pendiente",
        skipped: "sin resultado",
      };
      return `Sin probar en esta versión · ${verdict[row.previous.result]} en ${row.previous.version}`;
    }
  }
}

/** The errors of the last 15 days, oldest first, and the newest day that has a figure. */
export function companyErrorDays<Day extends { readonly date: string; readonly count: number }>(
  days: ReadonlyArray<Day>,
  nowMs: number,
) {
  const recent = days.slice(-15);
  const latest = recent.at(-1) ?? null;
  // @effect-diagnostics-next-line globalDate:off
  const now = new Date(nowMs);
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return { days: recent, latest, latestIsToday: latest?.date === today };
}
