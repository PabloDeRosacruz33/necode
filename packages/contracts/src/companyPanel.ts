import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Necode: the company panel, a right-panel app where the people running the company see its state
 * and answer its decisions. Its data lives as files in the host's panel folder, each published by
 * whoever owns it. A file that is missing or broken stays visible as such, never as zero.
 */
export const CompanyPanelDecisionOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** What changes if this option is chosen. */
  effect: Schema.optional(Schema.String),
  recommended: Schema.optional(Schema.Boolean),
});
export type CompanyPanelDecisionOption = typeof CompanyPanelDecisionOption.Type;

export const CompanyPanelDecision = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  createdAt: IsoDateTime,
  /** The kind of decision shown on the card, such as "Producto" or "Técnica". */
  area: Schema.optional(Schema.String),
  /** What "No lo entiendo" unfolds: the plain explanation and an everyday example. */
  problem: Schema.optional(Schema.String),
  example: Schema.optional(Schema.String),
  opinions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        thread: TrimmedNonEmptyString,
        /** The option this thread picks, from `options`. */
        optionId: Schema.optional(Schema.String),
        opinion: Schema.String,
      }),
    ),
  ),
  references: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        /** The option this product's way matches, from `options`. */
        optionId: Schema.optional(Schema.String),
        how: Schema.String,
        source: Schema.optional(Schema.String),
      }),
    ),
  ),
  /** More than a yes or no: answered with one button per option. */
  options: Schema.optional(Schema.Array(CompanyPanelDecisionOption)),
});
export type CompanyPanelDecision = typeof CompanyPanelDecision.Type;

export const CompanyPanelDecisionsFile = Schema.Struct({
  decisions: Schema.Array(CompanyPanelDecision),
});
export type CompanyPanelDecisionsFile = typeof CompanyPanelDecisionsFile.Type;

export const CompanyPanelCostPoint = Schema.Struct({
  date: TrimmedNonEmptyString,
  total: Schema.Number,
  parts: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, amount: Schema.Number })),
  /** The release that moved it, when known. */
  release: Schema.optional(Schema.String),
});
export type CompanyPanelCostPoint = typeof CompanyPanelCostPoint.Type;

/** Per-person cost by rule D205 of the company's working system, never a real average. */
export const CompanyPanelCostsFile = Schema.Struct({
  currency: TrimmedNonEmptyString,
  /** The rule's working days in a month. */
  daysPerMonth: Schema.Number,
  perPerson: Schema.Array(CompanyPanelCostPoint),
  simulator: Schema.optional(
    Schema.Struct({
      /** Monthly per-person cost at the base volume, without images. */
      withoutImages: Schema.Number,
      /** Monthly per-person cost of each fifth of that day's images. */
      perFifthOfImages: Schema.Number,
      baseVolume: Schema.Number,
    }),
  ),
  /** What was really spent per day. Context only: it is not the cost per person. */
  spendLast30Days: Schema.optional(
    Schema.Array(Schema.Struct({ date: TrimmedNonEmptyString, amount: Schema.Number })),
  ),
  cache: Schema.optional(
    Schema.Struct({ percent: Schema.Number, detail: Schema.optional(Schema.String) }),
  ),
});
export type CompanyPanelCostsFile = typeof CompanyPanelCostsFile.Type;

export const CompanyPanelSystemStatus = Schema.Literals(["ok", "warning", "down"]);
export type CompanyPanelSystemStatus = typeof CompanyPanelSystemStatus.Type;

export const CompanyPanelHealthFile = Schema.Struct({
  versions: Schema.Array(
    Schema.Struct({
      environment: TrimmedNonEmptyString,
      version: TrimmedNonEmptyString,
      detail: Schema.optional(Schema.String),
    }),
  ),
  systems: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      status: CompanyPanelSystemStatus,
      detail: Schema.optional(Schema.String),
      checkedAt: Schema.optional(IsoDateTime),
    }),
  ),
  errorsByDay: Schema.optional(
    Schema.Array(
      Schema.Struct({
        date: TrimmedNonEmptyString,
        count: Schema.Number,
        detail: Schema.optional(Schema.String),
      }),
    ),
  ),
  database: Schema.optional(
    Schema.Struct({
      readGbPerDay: Schema.Number,
      /** What it reads with nobody using it, and the level to stay under: they give the scale. */
      restGbPerDay: Schema.optional(Schema.Number),
      targetGbPerDay: Schema.optional(Schema.Number),
      detail: Schema.optional(Schema.String),
    }),
  ),
});
export type CompanyPanelHealthFile = typeof CompanyPanelHealthFile.Type;

export const CompanyPanelTestsFile = Schema.Struct({
  label: TrimmedNonEmptyString,
  passed: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.Number,
  /** The job log: test messages only, never conversations of real people. */
  jobs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        result: Schema.Literals(["passed", "failed", "skipped"]),
        before: Schema.optional(Schema.String),
        now: Schema.optional(Schema.String),
        why: Schema.optional(Schema.String),
        version: Schema.optional(Schema.String),
        suite: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type CompanyPanelTestsFile = typeof CompanyPanelTestsFile.Type;

const section = <S extends Schema.Top>(data: S) =>
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("missing") }),
    Schema.Struct({ status: Schema.Literal("invalid") }),
    Schema.Struct({ status: Schema.Literal("ok"), updatedAt: IsoDateTime, data }),
  ]);

export const CompanyPanelAnsweredDecision = Schema.Struct({
  decisionId: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  answer: TrimmedNonEmptyString,
  person: TrimmedNonEmptyString,
  answeredAt: IsoDateTime,
});
export type CompanyPanelAnsweredDecision = typeof CompanyPanelAnsweredDecision.Type;

export const CompanyPanelThreadActivity = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
});
export type CompanyPanelThreadActivity = typeof CompanyPanelThreadActivity.Type;

export const CompanyPanelSnapshot = Schema.Struct({
  /** Whether this host has a panel and this person may see it. */
  available: Schema.Boolean,
  person: Schema.NullOr(TrimmedNonEmptyString),
  decisions: section(CompanyPanelDecisionsFile),
  answered: Schema.Array(CompanyPanelAnsweredDecision),
  costs: section(CompanyPanelCostsFile),
  health: section(CompanyPanelHealthFile),
  tests: section(CompanyPanelTestsFile),
  threads: Schema.Array(CompanyPanelThreadActivity),
});
export type CompanyPanelSnapshot = typeof CompanyPanelSnapshot.Type;

export const CompanyPanelAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("yes") }),
  Schema.Struct({ type: Schema.Literal("no") }),
  Schema.Struct({ type: Schema.Literal("option"), optionId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("other"), text: TrimmedNonEmptyString }),
]);
export type CompanyPanelAnswer = typeof CompanyPanelAnswer.Type;

export const CompanyPanelAnswerInput = Schema.Struct({
  decisionId: TrimmedNonEmptyString,
  answer: CompanyPanelAnswer,
});
export type CompanyPanelAnswerInput = typeof CompanyPanelAnswerInput.Type;

export class CompanyPanelError extends Schema.TaggedError<CompanyPanelError>()(
  "CompanyPanelError",
  { message: Schema.String },
) {}
