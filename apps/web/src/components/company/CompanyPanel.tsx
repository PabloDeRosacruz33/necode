/**
 * Necode: the company panel, a right-panel app to see the state of the company and answer its
 * decisions without asking a thread. Everything shown comes from the server's panel snapshot; what
 * has no data says so ("Sin dato"), never a zero.
 */
import {
  COMPANY_PANEL_COLORS,
  COMPANY_PANEL_JOB_KINDS,
  COMPANY_PANEL_REFRESH_MS,
  COMPANY_PLAN_SQUARES,
  companyPlanTurn,
  COMPANY_THREAD_TONES,
  companyErrorsByPlanText,
  companyPanelPlans,
  companyPlanColor,
  companyTestsByPlan,
  companyThreadPlan,
  companyDatabaseIsStale,
  companyDatabaseView,
  companyErrorDays,
  companyPanelAgo,
  companyTestsByVersion,
  companyTestsVersionHeading,
  companyTestStateLabel,
  companyThreadTile,
  companyPanelJobKind,
  companyPanelJobsByUrgency,
  companyPanelJobTally,
  companyPanelShortDate,
  companyPanelShortLabel,
  companyPanelSuites,
  companyDecisionConsensus,
  companyDecisionMatrix,
  companyDecisionSealText,
  companyDecisionSwipeAction,
  companyDecisionTime,
  companyPanelJobState,
  companyPanelStaleLabel,
  costTrend,
  pendingCompanyDecisions,
  simulateMonthlyCost,
} from "@t3tools/client-runtime/state/company-panel";
import type {
  CompanyDecisionMatrixRow,
  CompanyPanelDataKind,
  CompanyPanelJobKind,
  CompanyPanelJobTally,
  CompanyPanelTone,
  CompanyTestRow,
  CompanyTestState,
  CompanyTestTally,
} from "@t3tools/client-runtime/state/company-panel";
import type {
  CompanyPanelAnswer,
  CompanyPanelCostsFile,
  CompanyPanelDecision,
  CompanyPanelHealthFile,
  CompanyPanelLogTone,
  CompanyPanelPlan,
  CompanyPanelSnapshot,
  CompanyPanelSystemStatus,
  CompanyPanelTestsFile,
  CompanyPanelThreadActivity,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { companyPanelEnvironment } from "~/state/companyPanel";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Tab = "home" | "decisions" | "costs" | "health";

const STATUS_DOT: Record<CompanyPanelSystemStatus, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  down: "bg-destructive",
};
const STATUS_LABEL: Record<CompanyPanelSystemStatus, string> = {
  ok: "Bien",
  warning: "Aviso",
  down: "Caído",
};

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat("es-ES", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
      useGrouping: "always",
    }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString("es-ES")} ${currency}`;
  }
};

/** Hover detail for a bar, a cell or a dot. */
function Hint(props: { readonly text: string; readonly children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup>{props.text}</TooltipPopup>
    </Tooltip>
  );
}

/** When the shown snapshot was fetched, to tell how old each file is. */
const FetchedAtContext = createContext(0);

function Stale(props: {
  readonly kind: CompanyPanelDataKind;
  readonly section: NonNullable<
    CompanyPanelSnapshot["health" | "costs" | "tests" | "decisions" | "plans"]
  >;
}) {
  const label = companyPanelStaleLabel(props.kind, props.section, use(FetchedAtContext));
  return label === null ? null : <span className="text-warning"> · {label}</span>;
}

const Label = ({ children }: { children: ReactNode }) => (
  <div className="text-2xs tracking-wider text-muted-foreground uppercase">{children}</div>
);
const Big = ({ children }: { children: ReactNode }) => (
  <div className="mt-1.5 font-mono text-3xl leading-tight">{children}</div>
);
const Sub = ({ children }: { children: ReactNode }) => (
  <div className="text-xs text-muted-foreground">{children}</div>
);
const Sub2 = ({ children }: { children: ReactNode }) => (
  <span className="text-xs text-muted-foreground">{children}</span>
);
const NoData = ({ what, broken }: { what?: string; broken?: boolean }) => (
  <div className="mt-2 text-xs text-muted-foreground italic">
    {broken ? "Dato ilegible" : "Sin dato"}
    {what ? ` · ${what}` : ""}
  </div>
);

function Tile(props: { readonly className?: string; readonly children: ReactNode }) {
  return (
    <div
      className={`rounded-xl border border-border bg-card p-3 text-left ${props.className ?? ""}`}
    >
      {props.children}
    </div>
  );
}

const TONE_BG: Record<CompanyPanelTone, string> = {
  good: "bg-success",
  warning: "bg-warning",
  bad: "bg-destructive",
  active: "bg-primary",
  neutral: "bg-muted-foreground/40",
};
const PART_COLORS = [
  "bg-primary",
  "bg-warning",
  "bg-success",
  "bg-foreground/50",
  "bg-destructive",
];

/** A horizontal bar made of coloured slices; hovering a slice says what it is. */
function SliceBar(props: {
  readonly slices: ReadonlyArray<{
    readonly key: string;
    readonly value: number;
    readonly className: string;
    readonly hint: string;
  }>;
}) {
  const total = props.slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return null;
  return (
    <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
      {props.slices
        .filter((slice) => slice.value > 0)
        .map((slice) => (
          <Hint key={slice.key} text={slice.hint}>
            <div
              className={`h-full ${slice.className} hover:opacity-80`}
              style={{ width: `${(slice.value / total) * 100}%` }}
            />
          </Hint>
        ))}
    </div>
  );
}

function CostBars({ costs }: { costs: CompanyPanelCostsFile }) {
  const max = Math.max(...costs.perPerson.map((point) => point.total), 1);
  const names = [
    ...new Set(costs.perPerson.flatMap((point) => point.parts.map((part) => part.name))),
  ];
  const color = (name: string) => PART_COLORS[names.indexOf(name) % PART_COLORS.length] ?? "";
  return (
    <div className="mt-2">
      <div className="flex h-28 items-end gap-2">
        {costs.perPerson.map((point) => (
          <div key={point.date} className="flex h-full min-w-0 flex-1 flex-col justify-end">
            <div className="mb-0.5 text-center font-mono text-xs">
              {money(point.total, costs.currency)}
            </div>
            <div
              className="flex flex-col-reverse gap-px overflow-hidden rounded-t-sm"
              style={{ height: `${Math.max((point.total / max) * 75, 4)}%` }}
            >
              {point.parts.map((part) => (
                <Hint key={part.name} text={`${part.name}: ${money(part.amount, costs.currency)}`}>
                  <div
                    className={`${color(part.name)} hover:opacity-80`}
                    style={{ flexGrow: part.amount, flexBasis: 0 }}
                  />
                </Hint>
              ))}
            </div>
            <div className="mt-1 truncate text-center text-2xs text-muted-foreground">
              {companyPanelShortDate(point.date)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        {names.map((name) => (
          <span key={name} className="flex items-center gap-1">
            <span className={`size-2 rounded-xs ${color(name)}`} />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

function CostSummary({ costs }: { costs: CompanyPanelCostsFile }) {
  const trend = costTrend(costs.perPerson);
  if (trend === null) return <NoData what="coste por persona" />;
  const percent = trend.sinceStartPercent;
  return (
    <>
      <Big>{money(trend.latest.total, costs.currency)}</Big>
      <Sub>
        {percent === null ? null : (
          <span className={percent <= 0 ? "text-success" : "text-destructive"}>
            {percent > 0 ? "+" : "−"}
            {Math.abs(Math.round(percent))} %
          </span>
        )}{" "}
        {percent === null
          ? ""
          : `desde el ${companyPanelShortDate(costs.perPerson[0]?.date ?? "")} · `}
        se recalcula solo
      </Sub>
    </>
  );
}

function Simulator({ costs }: { costs: CompanyPanelCostsFile }) {
  const [people, setPeople] = useState(10);
  const [volume, setVolume] = useState(costs.simulator?.baseVolume ?? 2.5);
  const [imageFifths, setImageFifths] = useState(1);
  if (!costs.simulator) return <NoData what="simulador" />;
  const total = simulateMonthlyCost(costs.simulator, { people, volume, imageFifths });
  const slider = (
    label: string,
    value: string,
    input: { value: number; min: number; max: number; step: number; set: (next: number) => void },
  ) => (
    <label className="block text-xs text-muted-foreground">
      {label}
      <b className="block text-sm text-foreground">{value}</b>
      <input
        type="range"
        className="mt-1.5 block w-full accent-primary"
        min={input.min}
        max={input.max}
        step={input.step}
        value={input.value}
        onChange={(event) => input.set(Number(event.target.value))}
      />
    </label>
  );
  return (
    <>
      <div className="grid grid-cols-1 items-end gap-4 @xl/company:grid-cols-3">
        {slider("Personas", String(people), {
          value: people,
          min: 1,
          max: 100,
          step: 1,
          set: setPeople,
        })}
        {slider("Volumen de Pablo", `×${String(volume).replace(".", ",")}`, {
          value: volume,
          min: 1,
          max: 4,
          step: 0.5,
          set: setVolume,
        })}
        {slider("Imágenes de ese día", imageFifths === 5 ? "todas" : `${imageFifths}/5`, {
          value: imageFifths,
          min: 1,
          max: 5,
          step: 1,
          set: setImageFifths,
        })}
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-border pt-3">
        <Sub>{money(total / people, costs.currency)} por persona</Sub>
        <span>
          <b className="text-2xl">{money(total, costs.currency)}</b> <Sub2>al mes</Sub2>
        </span>
      </div>
    </>
  );
}

function ErrorHeat({ health }: { health: CompanyPanelHealthFile }) {
  const fetchedAt = use(FetchedAtContext);
  if (!health.errorsByDay) return <NoData what="errores por día" />;
  const { days } = companyErrorDays(health.errorsByDay, fetchedAt);
  return (
    <div className="grid grid-cols-[repeat(15,1fr)] gap-0.75">
      {days.map((day) => (
        <Hint
          key={day.date}
          text={`${day.date}: ${day.count} ${day.count === 1 ? "error" : "errores"}${day.detail ? ` · ${day.detail}` : ""}`}
        >
          <div
            className={`aspect-square rounded-xs hover:outline hover:outline-foreground ${
              day.count === 0 ? "bg-foreground/12" : day.count > 5 ? "bg-destructive" : "bg-warning"
            }`}
          />
        </Hint>
      ))}
    </div>
  );
}

function SystemsGrid({ health }: { health: CompanyPanelHealthFile }) {
  return (
    <div className="grid grid-cols-2 content-start gap-1.5 @xl/company:grid-cols-3">
      {health.systems.map((system) => (
        <Hint
          key={system.name}
          text={`${STATUS_LABEL[system.status]}${system.detail ? ` · ${system.detail}` : ""}`}
        >
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-xs transition-colors hover:border-ring">
            <span className={`size-2 flex-none rounded-full ${STATUS_DOT[system.status]}`} />
            {system.name}
          </div>
        </Hint>
      ))}
    </div>
  );
}

function VersionsAndHealth({ health }: { health: CompanyPanelHealthFile }) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-4 @xl/company:grid-cols-[5fr_6fr]">
      <div className="space-y-2">
        {health.versions.map((version) => (
          <div key={version.environment} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <b>{version.environment}</b>
              <span className="font-mono text-base">{version.version}</span>
            </div>
          </div>
        ))}
      </div>
      <SystemsGrid health={health} />
    </div>
  );
}

const KIND_TONE = Object.fromEntries(
  COMPANY_PANEL_JOB_KINDS.map((entry) => [entry.kind, entry.tone]),
) as Record<CompanyPanelJobKind, CompanyPanelTone>;

function TallyBar({ tally }: { tally: CompanyPanelJobTally }) {
  return (
    <SliceBar
      slices={COMPANY_PANEL_JOB_KINDS.toReversed().map((entry) => ({
        key: entry.kind,
        value: tally[entry.kind],
        className: TONE_BG[entry.tone],
        hint: `${entry.label}: ${tally[entry.kind]}`,
      }))}
    />
  );
}

/** The battery at a glance: how much of it is done, as a bar. */
const TestsLine = ({ tests }: { tests: CompanyPanelTestsFile }) => {
  const total = tests.passed + tests.failed + tests.skipped;
  return (
    <>
      <div className="mt-1.5 font-mono text-2xl leading-tight">
        {tests.passed} <span className="text-base text-muted-foreground">de {total} bien</span>
      </div>
      <div className="my-1.5">
        <SliceBar
          slices={[
            {
              key: "ok",
              value: tests.passed,
              className: "bg-success",
              hint: `Bien: ${tests.passed}`,
            },
            {
              key: "ko",
              value: tests.failed,
              className: "bg-destructive",
              hint: `Falla: ${tests.failed}`,
            },
            {
              key: "no",
              value: tests.skipped,
              className: "bg-muted-foreground/40",
              hint: `Sin resultado: ${tests.skipped}`,
            },
          ]}
        />
      </div>
      <Sub>{companyPanelShortLabel(tests.label)}</Sub>
    </>
  );
};

type AnswerFn = (decisionId: string, answer: CompanyPanelAnswer) => void;

const Missing = ({ children }: { children: ReactNode }) => (
  <div className="mt-1 text-xs text-warning italic">{children}</div>
);

function MatrixRow(props: {
  readonly row: CompanyDecisionMatrixRow;
  readonly columns: ReturnType<typeof companyDecisionMatrix>["columns"];
  readonly template: string;
  /** Threads speak for themselves; only what others do needs a source. */
  readonly needsSource: boolean;
}) {
  const { row, columns } = props;
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="grid min-h-8 w-full items-center gap-1 text-left text-xs font-medium hover:bg-accent"
        style={{ gridTemplateColumns: props.template }}
      >
        <span className="min-w-0 py-1 break-words">{row.name}</span>
        {columns.map((column) => (
          <span key={column.id} className="flex justify-center">
            {row.optionId === column.id ? (
              <span
                role="img"
                aria-label={`Elige ${column.label}`}
                className={`size-3.5 rounded-full ${column.recommended ? "bg-success" : "bg-warning"}`}
              />
            ) : null}
          </span>
        ))}
      </button>
      {open ? (
        <div className="pb-2 text-xs">
          {row.reason}
          {row.source === null ? (
            props.needsSource ? (
              <span className="text-warning italic"> · sin fuente</span>
            ) : null
          ) : /^https?:\/\//.test(row.source) ? (
            <>
              {" · "}
              <a href={row.source} target="_blank" rel="noreferrer" className="underline">
                Fuente
              </a>
            </>
          ) : (
            ` · ${row.source}`
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Who picks what. Pressing a row shows its reason and source, which live nowhere else. */
function DecisionMatrix({ decision }: { decision: CompanyPanelDecision }) {
  const { columns, threads, others } = companyDecisionMatrix(decision);
  const template = `minmax(0,38%) repeat(${columns.length}, minmax(0,1fr))`;
  const group = (
    title: string,
    rows: ReadonlyArray<CompanyDecisionMatrixRow>,
    needsSource: boolean,
    missing: string,
  ) => (
    <>
      <div className="mt-2.5 mb-1">
        <Label>{title}</Label>
      </div>
      {rows.length > 0 ? (
        rows.map((row) => (
          <MatrixRow
            key={row.key}
            row={row}
            columns={columns}
            template={template}
            needsSource={needsSource}
          />
        ))
      ) : (
        <Missing>{missing}</Missing>
      )}
    </>
  );
  return (
    <div className="mt-2 rounded-lg bg-card p-2.5">
      <Sub>Pulsa una fila para ver el motivo y la fuente</Sub>
      {columns.length > 0 ? (
        <div
          className="mt-2 grid items-end gap-1 text-center text-xs leading-tight font-semibold"
          style={{ gridTemplateColumns: template }}
        >
          <span />
          {columns.map((column) => (
            <span key={column.id}>{column.label}</span>
          ))}
        </div>
      ) : null}
      {group("Hilos", threads, false, "Falta: ningún hilo ha dado su opinión.")}
      {group("Otros", others, true, "Falta: nadie ha mirado cómo lo hacen otros.")}
      {columns.length > 0 ? (
        <div
          className="grid min-h-8 items-center gap-1 border-t-2 border-border text-xs font-bold"
          style={{ gridTemplateColumns: template }}
        >
          <span>Total</span>
          {columns.map((column) => (
            <span key={column.id} className="text-center">
              {column.total}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The seal says the outcome; pressing it opens who picks what. */
function ConsensusSeal({ decision }: { decision: CompanyPanelDecision }) {
  const [open, setOpen] = useState(false);
  const consensus = companyDecisionConsensus(decision);
  const text = companyDecisionSealText(decision);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="mt-2.5 flex w-full items-center gap-2 rounded-lg bg-success/15 px-2.5 py-2 text-left text-xs font-semibold hover:bg-success/25"
      >
        {consensus ? (
          <span className="flex flex-none gap-1">
            {Array.from({ length: consensus.total }, (_, index) => (
              <span
                key={index}
                className={`size-2 rounded-full ${index < consensus.count ? "bg-success" : "bg-muted-foreground/40"}`}
              />
            ))}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">{text ?? "Faltan las opiniones de los hilos"}</span>
        <span className="flex-none font-normal text-muted-foreground">
          {open ? "Cerrar" : "Ver quién"}
        </span>
      </button>
      {open ? <DecisionMatrix decision={decision} /> : null}
    </>
  );
}

function OptionBackers(props: {
  readonly decision: CompanyPanelDecision;
  readonly optionId: string;
}) {
  const { threads, others } = companyDecisionMatrix(props.decision);
  const names = (rows: ReadonlyArray<CompanyDecisionMatrixRow>) =>
    rows.filter((row) => row.optionId === props.optionId).map((row) => row.name);
  const inThreads = names(threads);
  const inOthers = names(others);
  // Only worth saying once someone has picked: with no data at all, the seal says it is missing.
  if (inThreads.length + inOthers.length === 0) {
    return threads.length + others.length === 0 ? null : (
      <span className="mt-1.5 block text-xs text-muted-foreground">Nadie la elige</span>
    );
  }
  return (
    <>
      <Backers title="Hilos" names={inThreads} />
      <Backers title="Otros" names={inOthers} />
    </>
  );
}

function Backers(props: { readonly title: string; readonly names: ReadonlyArray<string> }) {
  if (props.names.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="w-9 flex-none text-muted-foreground">{props.title}</span>
      {props.names.map((name, index) => (
        <span key={`${name}:${index}`} className="rounded-full bg-foreground/8 px-2 font-medium">
          {name}
        </span>
      ))}
    </span>
  );
}

/** One decision, in the order Roi approved. Drag right, left or up does what the swipe says. */
function DecisionCard(props: {
  readonly decision: CompanyPanelDecision;
  readonly position: number;
  readonly total: number;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { decision } = props;
  const [explained, setExplained] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fetchedAt = use(FetchedAtContext);
  const options = decision.options ?? [];

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (writing || (event.target as HTMLElement).closest("button,textarea,a")) return;
    start.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) {
      setDrag({ x: event.clientX - start.current.x, y: event.clientY - start.current.y });
    }
  };
  const onPointerUp = () => {
    const moved = drag;
    start.current = null;
    setDrag(null);
    if (!moved) return;
    const swipe = moved.x > 90 ? "right" : moved.x < -90 ? "left" : moved.y < -70 ? "up" : null;
    if (swipe === null) return;
    const action = companyDecisionSwipeAction(decision, swipe);
    if (action === "write") setWriting(true);
    else if (action !== null) props.onAnswer(decision.id, action);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={
        drag
          ? {
              transform: `translate(${drag.x}px, ${Math.min(drag.y, 0)}px) rotate(${drag.x / 30}deg)`,
            }
          : undefined
      }
      className="flex touch-pan-y flex-col rounded-xl border border-border bg-background p-4 text-sm"
    >
      <Sub>
        Decisión {props.position} de {props.total}
        {decision.area ? ` · ${decision.area}` : ""} ·{" "}
        {companyDecisionTime(decision.createdAt, fetchedAt)}
      </Sub>
      <div className="mt-1 text-lg leading-snug font-semibold">{decision.title}</div>
      <p className="mt-1.5">{decision.summary}</p>
      <ConsensusSeal decision={decision} />

      <div className="mt-3">
        <Label>Elige</Label>
      </div>
      <div className="mt-1.5 space-y-1.5">
        {options.length > 0 ? (
          options.map((option) => (
            <button
              type="button"
              key={option.id}
              disabled={props.busy}
              className={`block w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-accent disabled:opacity-50 ${option.recommended ? "border-2 border-success" : "border-border"}`}
              onClick={() => props.onAnswer(decision.id, { type: "option", optionId: option.id })}
            >
              <span className="block min-w-0">
                <span className="font-medium">{option.label}</span>
                {option.recommended ? (
                  <span className="block text-xs text-success">Recomendada</span>
                ) : null}
                {option.effect ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.effect}
                  </span>
                ) : null}
                <OptionBackers decision={decision} optionId={option.id} />
              </span>
            </button>
          ))
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              disabled={props.busy}
              className="rounded-lg border border-destructive bg-destructive/15 p-2.5 disabled:opacity-50"
              onClick={() => props.onAnswer(decision.id, { type: "no" })}
            >
              ← No
            </button>
            <button
              type="button"
              disabled={props.busy}
              className="rounded-lg border border-success bg-success/15 p-2.5 disabled:opacity-50"
              onClick={() => props.onAnswer(decision.id, { type: "yes" })}
            >
              Sí →
            </button>
          </div>
        )}
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="rounded-lg border border-border bg-card p-2 text-xs hover:bg-accent"
          onClick={() => setExplained((current) => !current)}
        >
          {explained ? "Ocultar" : "No lo entiendo"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-border bg-card p-2 text-xs hover:bg-accent"
          onClick={() => setWriting((current) => !current)}
        >
          Quiero otra cosa
        </button>
      </div>

      {explained ? (
        <div className="mt-2 space-y-1.5 rounded-lg bg-card p-2.5">
          {decision.problem ? (
            <p>{decision.problem}</p>
          ) : (
            <Missing>Falta la explicación fácil.</Missing>
          )}
          {decision.example ? (
            <p>
              <b>Ejemplo:</b> {decision.example}
            </p>
          ) : (
            <Missing>Falta el ejemplo.</Missing>
          )}
        </div>
      ) : null}

      {writing ? (
        <div className="mt-2">
          <textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Escribe lo que quieres…"
            className="min-h-16 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground outline-none focus:border-ring"
          />
          <button
            type="button"
            disabled={props.busy || text.trim() === ""}
            className="mt-1.5 w-full rounded-lg border border-success bg-success/15 p-1.5 text-xs disabled:opacity-50"
            onClick={() => props.onAnswer(decision.id, { type: "other", text: text.trim() })}
          >
            Enviar
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PendingDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const section = props.snapshot.decisions;
  if (section.status !== "ok")
    return <NoData broken={section.status === "invalid"} what="decisiones" />;
  const decision = section.data.decisions[0];
  if (decision === undefined) {
    return (
      <div className="mt-2 rounded-xl border border-border bg-background p-3 text-sm">
        <span className="text-success">✓</span> Nada que decidir ahora.
        <Sub>Las nuevas aparecen aquí solas.</Sub>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <DecisionCard
        key={decision.id}
        decision={decision}
        position={1}
        total={section.data.decisions.length}
        busy={props.busy}
        onAnswer={props.onAnswer}
      />
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 inline-block rounded-full bg-destructive px-1.75 text-2xs text-white">
      {count}
    </span>
  );
}

const LOG_TONE_DOT: Record<CompanyPanelLogTone, string> = {
  good: "bg-success",
  warning: "bg-warning",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};
const TEST_STATE_DOT: Record<CompanyTestState, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  warning: "bg-warning",
  pending: "bg-muted-foreground/60",
  skipped: "bg-muted-foreground/60",
  untested: "bg-muted-foreground/30",
};
const STATUS_WORD: Record<CompanyPanelSystemStatus, string> = {
  ok: "bien",
  warning: "con aviso",
  down: "caída",
};
const UNTESTED_FILL =
  "repeating-linear-gradient(135deg, var(--muted-foreground) 0 2px, transparent 2px 6px)";

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h4 className="mt-4 mb-1.5 text-2xs tracking-wider text-muted-foreground uppercase first:mt-0">
    {children}
  </h4>
);

/** A block of the home. With `detail`, pressing it opens that detail in place. */
function Block(props: {
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  readonly openHint?: string;
  readonly detail?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = props.detail !== undefined;
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,a,input,textarea,[data-block-detail]"))
      return;
    setOpen((current) => !current);
  };
  return (
    <section
      {...(expandable ? { onClick } : {})}
      className={`rounded-2xl border border-border bg-card p-4 ${expandable ? "cursor-pointer transition-colors hover:border-ring" : ""} ${props.className ?? ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <b className="text-sm font-semibold">{props.title}</b>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {props.aside}
          {expandable ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              className="hover:text-foreground"
            >
              {open ? "Cerrar" : (props.openHint ?? "Pulsa para ver el detalle")}
            </button>
          ) : null}
        </span>
      </div>
      {props.children}
      {open ? (
        <div data-block-detail className="mt-4 cursor-default border-t border-border pt-4">
          {props.detail}
        </div>
      ) : null}
    </section>
  );
}

/** Lines over a shared x axis; a shorter series just stops early, like today against yesterday. */
function LineChart(props: {
  readonly series: ReadonlyArray<{
    readonly name?: string;
    readonly values: ReadonlyArray<number>;
    readonly color: string;
  }>;
  readonly height: number;
  readonly label: (index: number) => string;
  readonly format: (value: number) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const count = Math.max(...props.series.map((line) => line.values.length));
  if (count < 2) return null;
  const width = 460;
  const baseline = props.height - 2;
  const max = Math.max(...props.series.flatMap((line) => line.values), 1);
  const x = (index: number) => (index * width) / (count - 1);
  const y = (value: number) => baseline - (value / max) * (baseline - 6);
  return (
    <div
      className="relative mt-2.5"
      onMouseLeave={() => setHovered(null)}
      onMouseMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - box.left) / box.width;
        setHovered(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
      }}
    >
      <svg
        viewBox={`0 0 ${width} ${props.height}`}
        preserveAspectRatio="none"
        className="block w-full overflow-visible"
        style={{ height: props.height }}
        aria-hidden
      >
        <line x1={0} x2={width} y1={baseline} y2={baseline} stroke="var(--border)" />
        {props.series.map((line) => (
          <polyline
            key={line.name ?? line.color}
            points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hovered === null ? null : (
          <line
            x1={x(hovered)}
            x2={x(hovered)}
            y1={4}
            y2={baseline}
            stroke="var(--muted-foreground)"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="mt-1 flex justify-between text-2xs text-muted-foreground">
        <span>{props.label(0)}</span>
        <span>{props.label(count - 1)}</span>
      </div>
      {hovered === null ? null : (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-popover px-2 py-0.5 text-xs whitespace-nowrap text-popover-foreground"
          style={
            hovered > count / 2
              ? { right: `${100 - (hovered / (count - 1)) * 100}%` }
              : { left: `${(hovered / (count - 1)) * 100}%` }
          }
        >
          {props.label(hovered)}:{" "}
          {props.series
            .flatMap((line) => {
              const value = line.values[hovered];
              if (value === undefined) return [];
              return [`${line.name ? `${line.name} ` : ""}${props.format(value)}`];
            })
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function CacheRing({ percent, detail }: { percent: number; detail: string }) {
  const circumference = 2 * Math.PI * 32;
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 border-t border-border pt-3 text-center @xl/company:border-t-0 @xl/company:border-l @xl/company:pt-0 @xl/company:pl-4">
      <svg
        viewBox="0 0 80 80"
        className="size-19"
        role="img"
        aria-label={`Caché ${Math.round(percent)} %`}
      >
        <circle cx={40} cy={40} r={32} fill="none" stroke="var(--muted)" strokeWidth={8} />
        <circle
          cx={40}
          cy={40}
          r={32}
          fill="none"
          stroke="var(--success)"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
          transform="rotate(-90 40 40)"
        />
        <text x={40} y={46} textAnchor="middle" fill="currentColor" fontSize={19} fontWeight={700}>
          {Math.round(percent)}%
        </text>
      </svg>
      <b className="text-xs">Caché</b>
      <Sub>{detail}</Sub>
    </div>
  );
}

function CostBlock({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const section = snapshot.costs;
  const title = (
    <>
      Coste por persona
      <Stale kind="costs" section={section} />
    </>
  );
  if (section.status !== "ok") {
    return (
      <Block title={title}>
        <NoData broken={section.status === "invalid"} />
      </Block>
    );
  }
  const costs = section.data;
  const latest = costs.perPerson.at(-1);
  const first = costs.perPerson[0];
  if (latest === undefined || first === undefined) {
    return (
      <Block title={title}>
        <NoData what="coste por persona" />
      </Block>
    );
  }
  const totals = costs.perPerson.map((point) => point.total);
  const dateLabel = (index: number) => companyPanelShortDate(costs.perPerson[index]?.date ?? "");
  const euros = (value: number) => money(value, costs.currency);
  const moved =
    latest.total === first.total
      ? `igual desde el ${companyPanelShortDate(first.date)}`
      : `${latest.total < first.total ? "bajó" : "subió"} desde ${euros(first.total)}`;
  const partColor = (index: number) =>
    COMPANY_PANEL_COLORS.parts[index % COMPANY_PANEL_COLORS.parts.length];
  return (
    <Block
      title={title}
      detail={
        <>
          <SectionTitle>Por qué bajó</SectionTitle>
          <LineChart
            series={[{ values: totals, color: COMPANY_PANEL_COLORS.parts[0] }]}
            height={130}
            label={dateLabel}
            format={euros}
          />
          {costs.drops?.length ? (
            <div className="mt-2">
              {costs.drops.map((drop) => (
                <div
                  key={drop.reason}
                  className="grid grid-cols-[3.5rem_0.625rem_minmax(0,1fr)] items-baseline gap-2 border-t border-border py-1.5 text-xs"
                >
                  <span className="font-mono">
                    {drop.amount > 0 ? "+" : "−"}
                    {euros(Math.abs(drop.amount))}
                  </span>
                  <span
                    className={`size-2 rounded-full ${drop.amount > 0 ? "bg-destructive" : "bg-success"}`}
                  />
                  <span>{drop.reason}</span>
                </div>
              ))}
            </div>
          ) : (
            <NoData what="por qué se ha movido" />
          )}
          <SectionTitle>Cómo se calcula</SectionTitle>
          <Sub>
            El día más fuerte de Pablo García ×{" "}
            {String(costs.simulator?.baseVolume ?? 2.5).replace(".", ",")}, imágenes entre 5 y
            precios de hoy, a {costs.daysPerMonth} días al mes.
          </Sub>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 @xl/company:grid-cols-[minmax(0,1fr)_7.5rem]">
        <div className="min-w-0">
          <span className="text-4xl leading-none font-bold tracking-tight">
            {euros(latest.total)}
          </span>{" "}
          <Sub2>al mes · {moved}</Sub2>
          <LineChart
            series={[{ values: totals, color: COMPANY_PANEL_COLORS.parts[0] }]}
            height={72}
            label={dateLabel}
            format={euros}
          />
          <div className="mt-3 flex h-3 gap-0.5">
            {latest.parts.map((part, index) => (
              <Hint key={part.name} text={`${part.name}: ${euros(part.amount)}`}>
                <div
                  className="rounded-xs"
                  style={{ flexGrow: part.amount, flexBasis: 0, background: partColor(index) }}
                />
              </Hint>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
            {latest.parts.map((part, index) => (
              <span key={part.name} className="flex items-center gap-1">
                <span className="size-2 rounded-xs" style={{ background: partColor(index) }} />
                {part.name} {euros(part.amount)}
              </span>
            ))}
          </div>
        </div>
        {costs.cache ? (
          <CacheRing percent={costs.cache.percent} detail="Lo que no pagamos entero" />
        ) : (
          <NoData what="caché" />
        )}
      </div>
    </Block>
  );
}

/** Inside a plan: its road, what stands out, and only if it is theirs, what the reader must do. */
function PlanDetail(props: { readonly plan: CompanyPanelPlan; readonly person: string | null }) {
  const { plan } = props;
  const [pressed, setPressed] = useState<number | null>(null);
  const color = companyPlanColor(plan.color);
  const turn = companyPlanTurn(plan, props.person);
  const squares = plan.squares ?? [];
  const open = pressed === null ? undefined : squares[pressed];
  return (
    <div
      className="col-span-full rounded-2xl border border-t-4 border-border bg-background p-5"
      style={{ borderTopColor: color }}
    >
      <p className="text-2xl font-bold tracking-tight">{plan.name}</p>
      {plan.steps.length === 0 ? (
        <NoData what="camino" />
      ) : (
        <div className="mt-6 mb-2 flex">
          {plan.steps.map((step, index) => {
            const reached = step.status !== "todo";
            return (
              <div
                key={`${step.label}:${index}`}
                className={`relative min-w-0 flex-1 text-center text-xs leading-snug wrap-break-word ${reached ? "text-foreground" : "text-muted-foreground"} ${step.status === "doing" ? "font-bold" : ""}`}
              >
                {index > 0 ? (
                  <span
                    className={`absolute top-4 -left-1/2 h-1 w-full ${reached ? "" : "bg-foreground/14"}`}
                    style={reached ? { background: color } : undefined}
                  />
                ) : null}
                <span
                  className={`relative z-1 mx-auto mb-1.5 flex size-9 items-center justify-center rounded-full text-sm font-bold ${reached ? "text-white" : "bg-muted text-foreground"}`}
                  style={
                    reached
                      ? {
                          background: color,
                          ...(step.status === "doing" ? { boxShadow: `0 0 0 5px ${color}4d` } : {}),
                        }
                      : undefined
                  }
                >
                  {step.status === "done" ? "✓" : index + 1}
                </span>
                {step.label}
                {step.who ? (
                  <span className="block text-2xs font-medium text-muted-foreground">
                    {step.who}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {squares.length === 0 ? (
        <NoData what="cuadrados" />
      ) : (
        <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2.5">
          {squares.map((square, index) => {
            const look = COMPANY_PLAN_SQUARES[square.status];
            return (
              <button
                type="button"
                key={`${square.text}:${index}`}
                aria-expanded={pressed === index}
                aria-label={`${look.label}: ${square.text}`}
                onClick={() => setPressed((current) => (current === index ? null : index))}
                style={{ background: look.color }}
                className={`block min-h-21 w-full rounded-xl p-3.5 text-left text-white -outline-offset-2 hover:outline-2 hover:outline-foreground ${pressed === index ? "outline-2 outline-foreground" : ""}`}
              >
                <span aria-hidden className="flex h-6 items-center text-xl leading-none font-bold">
                  {look.icon}
                </span>
                <b className="mt-1 block text-sm leading-snug">{square.text}</b>
              </button>
            );
          })}
        </div>
      )}
      {open ? (
        <div className="mt-2.5 rounded-xl bg-foreground/7 p-3.5 text-sm">
          {open.why ?? <span className="text-muted-foreground italic">Sin dato</span>}
        </div>
      ) : null}
      {turn ? (
        <div
          className="mt-3.5 rounded-xl p-3.5 text-center font-bold text-white"
          style={{ background: COMPANY_PLAN_SQUARES.decide.color }}
        >
          {turn}
        </div>
      ) : null}
    </div>
  );
}

function PlansBlock({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const [selected, setSelected] = useState<string | null>(null);
  const section = snapshot.plans ?? { status: "missing" as const };
  const plans = companyPanelPlans(snapshot);
  const open = plans.find((plan) => plan.id === selected);
  return (
    <Block
      title={
        <span className="text-base">
          Planes
          <Stale kind="plans" section={section} />
        </span>
      }
    >
      {plans.length === 0 ? (
        <NoData broken={section.status === "invalid"} what="planes" />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(24rem,100%),1fr))] gap-3">
          {plans.map((plan) => {
            const color = companyPlanColor(plan.color);
            return (
              <button
                type="button"
                key={plan.id}
                aria-expanded={selected === plan.id}
                onClick={() => setSelected((current) => (current === plan.id ? null : plan.id))}
                style={{ borderTopColor: color }}
                className="block w-full rounded-xl border border-t-4 border-border bg-background p-3.5 text-left hover:bg-accent"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <b className="text-sm">{plan.name}</b>
                  {plan.summary ? <Sub2>{plan.summary}</Sub2> : null}
                </span>
                {plan.steps.length === 0 ? (
                  <NoData what="pasos" />
                ) : (
                  <span className="mt-2.5 flex gap-1">
                    {plan.steps.map((step, index) => (
                      <span
                        key={`${step.label}:${index}`}
                        className={`min-w-0 flex-auto text-xs leading-tight wrap-break-word ${step.status === "doing" ? "font-semibold" : ""}`}
                      >
                        <span
                          className={`mb-1 block h-2 rounded-full ${step.status === "todo" ? "bg-foreground/12" : ""}`}
                          style={
                            step.status === "done"
                              ? { background: color }
                              : step.status === "doing"
                                ? {
                                    background: `repeating-linear-gradient(90deg, ${color} 0 5px, ${color}73 5px 9px)`,
                                  }
                                : undefined
                          }
                        />
                        {step.label}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
          {open ? <PlanDetail key={open.id} plan={open} person={snapshot.person} /> : null}
        </div>
      )}
    </Block>
  );
}

function ThreadStage({ title, text, color }: { title: string; text?: string; color?: string }) {
  return (
    <div
      className="min-w-0 rounded-lg border border-border p-2.5 text-xs"
      style={color ? { borderColor: color } : undefined}
    >
      <div className="mb-0.5 text-2xs font-semibold text-muted-foreground">{title}</div>
      {text ?? <span className="text-muted-foreground italic">Sin dato</span>}
    </div>
  );
}

function ThreadDetail(props: {
  readonly thread: CompanyPanelThreadActivity;
  readonly state: string;
  readonly plan: { readonly name: string; readonly color: string };
}) {
  const { thread, plan } = props;
  const fetchedAt = use(FetchedAtContext);
  return (
    <div
      className="mt-3 rounded-xl border border-l-4 border-border bg-background p-4"
      style={{ borderLeftColor: plan.color }}
    >
      <Sub>
        {thread.name} · {plan.name} · {props.state}
        {thread.updatedAt ? ` · ${companyPanelAgo(thread.updatedAt, fetchedAt)}` : ""}
      </Sub>
      <p className="mt-1 mb-3 text-lg leading-snug font-bold">
        {thread.now ?? thread.phrase ?? props.state}
      </p>
      <div className="grid grid-cols-1 gap-2 @xl/company:grid-cols-3">
        <ThreadStage title="✓ ACABA DE HACER" {...(thread.done ? { text: thread.done } : {})} />
        <ThreadStage
          title={"▶\uFE0E AHORA"}
          color={plan.color}
          {...(thread.now ? { text: thread.now } : {})}
        />
        <ThreadStage title="DESPUÉS" {...(thread.next ? { text: thread.next } : {})} />
      </div>
      {thread.needsYou ? (
        <div
          className="mt-2.5 rounded-lg p-2.5 text-xs font-semibold"
          style={{ background: `${COMPANY_PANEL_COLORS.decision}29` }}
        >
          Necesita de ti: {thread.needsYou}
        </div>
      ) : null}
      {thread.waitingFor ? (
        <div className="mt-2.5 rounded-lg bg-foreground/6 p-2.5 text-xs font-semibold">
          Espera a: {thread.waitingFor}
        </div>
      ) : null}
    </div>
  );
}

function ThreadsBlock({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const fetchedAt = use(FetchedAtContext);
  const [selected, setSelected] = useState<string | null>(null);
  const decisionThreads = new Set(
    pendingCompanyDecisions(snapshot).flatMap((decision) =>
      decision.thread ? [decision.thread] : [],
    ),
  );
  const plans = companyPanelPlans(snapshot);
  const tiles = snapshot.threads.map((thread) => ({
    thread,
    plan: companyThreadPlan(thread.name, plans),
    tile: companyThreadTile(thread, { nowMs: fetchedAt, decisionThreads }),
  }));
  const open = tiles.find((entry) => entry.thread.name === selected);
  return (
    <Block
      title={<span className="text-base">Hilos</span>}
      aside={
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
          <span>Color grande: su plan · Franja derecha:</span>
          {Object.values(COMPANY_THREAD_TONES).map((tone) => (
            <span key={tone.label} className="flex items-center gap-1">
              <span className="size-2 rounded-xs" style={{ background: tone.color }} />
              {tone.icon} {tone.label}
            </span>
          ))}
        </span>
      }
    >
      {tiles.length === 0 ? (
        <NoData what="hilos" />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 @xl/company:grid-cols-3">
          {tiles.map(({ thread, tile, plan }) => (
            <button
              type="button"
              key={thread.name}
              aria-expanded={selected === thread.name}
              aria-label={`${thread.name}, ${plan.name}, ${tile.state}`}
              onClick={() =>
                setSelected((current) => (current === thread.name ? null : thread.name))
              }
              className={`grid min-h-23 w-full grid-cols-[4fr_1fr] overflow-hidden rounded-xl text-left text-white -outline-offset-2 hover:outline-2 hover:outline-foreground ${selected === thread.name ? "outline-2 outline-foreground" : ""}`}
            >
              <span className="min-w-0 p-3" style={{ background: plan.color }}>
                <b className="block text-sm leading-tight font-bold">{thread.name}</b>
                <span className="mt-1 block text-xs leading-snug">
                  {thread.phrase ?? tile.state}
                  {thread.phrase && thread.updatedAt
                    ? ` · ${companyPanelAgo(thread.updatedAt, fetchedAt)}`
                    : ""}
                </span>
                {tile.caveat && thread.phrase ? (
                  <span className="mt-1 block text-2xs leading-snug">{tile.caveat}</span>
                ) : null}
              </span>
              <span
                aria-hidden
                className="flex items-center justify-center text-lg font-bold"
                style={{ background: COMPANY_THREAD_TONES[tile.tone].color }}
              >
                {COMPANY_THREAD_TONES[tile.tone].icon}
              </span>
            </button>
          ))}
        </div>
      )}
      {open ? <ThreadDetail thread={open.thread} state={open.tile.state} plan={open.plan} /> : null}
    </Block>
  );
}

const Figure = ({ value, children }: { value: string | null; children: ReactNode }) => (
  <div>
    {value === null ? (
      <span className="block text-sm text-muted-foreground italic">Sin dato</span>
    ) : (
      <b className="block text-xl leading-tight">{value}</b>
    )}
    <Sub>{children}</Sub>
  </div>
);

const gigabytes = (value: number | undefined) =>
  value === undefined ? null : `${Math.round(value).toLocaleString("es-ES")} GB`;

function DatabaseBlock({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const fetchedAt = use(FetchedAtContext);
  const section = snapshot.health;
  const database = section.status === "ok" ? section.data.database : undefined;
  if (database === undefined) {
    return (
      <Block title="Base de datos">
        <NoData broken={section.status === "invalid"} />
      </Block>
    );
  }
  const { checkedAt, status, today, yesterday, log } = database;
  const old = checkedAt !== undefined && companyDatabaseIsStale(checkedAt, fetchedAt);
  const view = companyDatabaseView(database);
  const hourLabel = (index: number) => `${index}:00`;
  return (
    <Block
      title={
        <>
          {status && !old ? (
            <span className={`mr-1.5 inline-block size-2.5 rounded-full ${STATUS_DOT[status]}`} />
          ) : null}
          Base de datos{status && !old ? `: ${STATUS_WORD[status]}` : ""}
        </>
      }
      aside={
        checkedAt === undefined ? (
          <Stale kind="health" section={section} />
        ) : (
          <span className={old ? "text-warning" : ""}>
            {old ? "viejo · " : ""}
            {companyPanelAgo(checkedAt, fetchedAt)}
          </span>
        )
      }
      openHint="Pulsa para ver el registro"
      detail={
        <>
          <SectionTitle>Lo que ha pasado</SectionTitle>
          {log?.length ? (
            log.map((entry) => (
              <div
                key={`${entry.at}:${entry.text}`}
                className="grid grid-cols-[5.5rem_0.625rem_minmax(0,1fr)] items-baseline gap-2 border-t border-border py-1.5 text-xs"
              >
                <Sub2>{companyDecisionTime(entry.at, fetchedAt)}</Sub2>
                <span className={`size-2 rounded-full ${LOG_TONE_DOT[entry.tone]}`} />
                <span>{entry.text}</span>
              </div>
            ))
          ) : (
            <NoData what="registro" />
          )}
        </>
      }
    >
      <div className="mb-1.5 grid grid-cols-1 gap-3 @xl/company:grid-cols-3">
        <Figure
          value={
            database.callsPerMinute === undefined
              ? null
              : database.callsPerMinute.toLocaleString("es-ES")
          }
        >
          llamadas por minuto
        </Figure>
        <Figure value={gigabytes(database.readGbToday)}>
          leídos hoy · ayer {gigabytes(database.readGbYesterday) ?? "sin dato"}
        </Figure>
        <Figure value={view ? `${view.percentOfWarning} %` : null}>
          de nuestro aviso
          {database.targetGbPerDay
            ? ` (${database.targetGbPerDay.toLocaleString("es-ES", { useGrouping: true })} GB/día)`
            : ""}
          <span className="block">
            Conexiones{" "}
            {database.connectionsUsed === undefined || database.connectionsLimit === undefined
              ? "sin dato"
              : `${database.connectionsUsed} de ${database.connectionsLimit}`}
          </span>
        </Figure>
      </div>
      {today || yesterday ? (
        <>
          <LineChart
            series={[
              {
                name: "Ayer",
                values: yesterday ?? [],
                color: "var(--muted-foreground)",
              },
              { name: "Hoy", values: today ?? [], color: COMPANY_PANEL_COLORS.parts[0] },
            ]}
            height={90}
            label={hourLabel}
            format={(value) => `${Math.round(value)}/min`}
          />
          <div className="mt-1.5 flex gap-3 text-2xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="size-2 rounded-xs"
                style={{ background: COMPANY_PANEL_COLORS.parts[0] }}
              />
              Hoy
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-xs bg-muted-foreground" />
              Ayer
            </span>
          </div>
        </>
      ) : (
        <NoData what="gráfica de hoy contra ayer" />
      )}
    </Block>
  );
}

function TestTallyBar({ tally, thick }: { tally: CompanyTestTally; thick?: boolean }) {
  const height = thick ? "h-5.5" : "h-2.5";
  const slice = (value: number, className: string, style?: { backgroundImage: string }) =>
    value > 0 ? (
      <div
        className={`rounded-xs ${height} ${className}`}
        style={{ flexGrow: value, flexBasis: 0, ...style }}
      />
    ) : null;
  return (
    <div className={`flex gap-0.5 ${height}`}>
      {slice(tally.passed, "bg-success")}
      {slice(tally.failed, "bg-destructive")}
      {slice(tally.warning, "bg-warning")}
      {slice(tally.untested, "border border-border", { backgroundImage: UNTESTED_FILL })}
    </div>
  );
}

function TestTallyWords(props: { tally: CompanyTestTally; missing: (count: number) => string }) {
  const { tally, missing } = props;
  return (
    <span className="flex flex-wrap justify-end gap-x-2 text-xs font-semibold">
      {tally.passed > 0 ? <span className="text-success">{tally.passed} bien</span> : null}
      {tally.failed > 0 ? (
        <span className="text-destructive">
          {tally.failed} {tally.failed === 1 ? "falla" : "fallan"}
        </span>
      ) : null}
      {tally.warning > 0 ? <span className="text-warning">{tally.warning} con aviso</span> : null}
      {tally.untested > 0 ? (
        <span className="text-muted-foreground">
          {tally.untested} {missing(tally.untested)}
        </span>
      ) : null}
    </span>
  );
}

function TestRowView({ row }: { row: CompanyTestRow }) {
  return (
    <div
      className={`grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-baseline gap-2 border-t border-border py-1.5 text-xs ${row.state === "untested" ? "opacity-60" : ""}`}
    >
      <span className={`size-2 rounded-full ${TEST_STATE_DOT[row.state]}`} />
      <span>
        {row.message}
        <Sub>
          {row.suite} · {companyTestStateLabel(row)}
          {row.why ? ` · ${row.why}` : ""}
        </Sub>
      </span>
      <span className="flex items-center gap-1">
        {row.history.slice(-8).map((result, index) => (
          <span key={index} className={`size-2 rounded-full ${TEST_STATE_DOT[result]}`} />
        ))}
      </span>
    </div>
  );
}

function TestPlanRow(props: { readonly group: ReturnType<typeof companyTestsByPlan>[number] }) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        disabled={group.rows.length === 0}
        onClick={() => setOpen((current) => !current)}
        className="grid w-full grid-cols-[8rem_minmax(0,1fr)] items-center gap-2.5 py-2 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent @xl/company:grid-cols-[8rem_minmax(0,1fr)_9.5rem]"
      >
        <span className="flex min-w-0 items-center gap-1.5 font-semibold">
          <span className="h-5.5 w-1.5 flex-none rounded-xs" style={{ background: group.color }} />
          <span className="min-w-0">{group.name}</span>
        </span>
        {group.rows.length === 0 ? (
          <span className="text-muted-foreground italic @xl/company:col-span-2">
            Sin dato · sin pruebas de este plan
          </span>
        ) : (
          <>
            <TestTallyBar tally={group.tally} />
            <span className="col-span-full @xl/company:col-span-1">
              <TestTallyWords
                tally={group.tally}
                missing={(count) => (count === 1 ? "falta" : "faltan")}
              />
            </span>
          </>
        )}
      </button>
      {open ? group.rows.map((row) => <TestRowView key={row.id} row={row} />) : null}
    </div>
  );
}

function TestsAndErrorsBlock({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const fetchedAt = use(FetchedAtContext);
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const byVersion = tests ? companyTestsByVersion(tests) : null;
  const plans = companyPanelPlans(snapshot);
  const errors = health?.errorsByDay ? companyErrorDays(health.errorsByDay, fetchedAt) : null;
  const heading = byVersion
    ? companyTestsVersionHeading(byVersion.version, health?.versions ?? [])
    : null;
  return (
    <Block
      title={
        <>
          Pruebas reales y errores
          <Stale kind="tests" section={snapshot.tests} />
        </>
      }
      aside={byVersion ? "Pulsa un plan para ver sus pruebas" : undefined}
    >
      {byVersion ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span>
              <b className="text-lg">{heading?.title}</b>
              {heading?.app ? <Sub2> · {heading.app}</Sub2> : null}
            </span>
            <TestTallyWords tally={byVersion.tally} missing={() => "sin probar"} />
          </div>
          <div className="mt-2.5 mb-3.5">
            <TestTallyBar tally={byVersion.tally} thick />
          </div>
          {companyTestsByPlan(byVersion.rows, plans).map((group) => (
            <TestPlanRow key={group.id} group={group} />
          ))}
        </>
      ) : (
        <NoData
          broken={snapshot.tests.status === "invalid"}
          what={snapshot.tests.status === "ok" ? "por versión" : "pruebas"}
        />
      )}
      <div className="mt-3.5 border-t-2 border-border pt-3.5">
        {health && errors?.latest ? (
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4">
            <div>
              <div className="text-2xl leading-none font-bold">{errors.latest.count}</div>
              <Sub2>
                {errors.latestIsToday
                  ? "errores hoy"
                  : `errores el ${companyPanelShortDate(errors.latest.date)}`}
              </Sub2>
            </div>
            <div>
              <ErrorHeat health={health} />
              <div className="mt-1.5">
                <Sub>
                  Últimos 15 días, el último a la derecha ·{" "}
                  {companyErrorsByPlanText(errors.latest, plans) ?? "por plan: sin dato"}
                </Sub>
              </div>
            </div>
          </div>
        ) : (
          <NoData what="errores" />
        )}
      </div>
    </Block>
  );
}

function SystemStrip({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const section = snapshot.health;
  const strip = section.status === "ok" ? section.data.strip : undefined;
  return (
    <section className="flex flex-wrap items-center gap-3.5 rounded-2xl border border-border bg-card px-4 py-2.5 text-xs">
      <b>
        Sistema
        <Stale kind="health" section={section} />
      </b>
      {strip?.length ? (
        strip.map((item) => (
          <span key={item.text} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-full ${STATUS_DOT[item.status]}`} />
            {item.text}
          </span>
        ))
      ) : (
        <span className="text-muted-foreground italic">Sin dato</span>
      )}
    </section>
  );
}

function DecisionsBlock(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onToggle: () => void;
}) {
  const { snapshot } = props;
  const pending = pendingCompanyDecisions(snapshot);
  const first = pending[0];
  const expandable = first !== undefined;
  return (
    <section
      {...(expandable && !props.open ? { onClick: props.onToggle } : {})}
      className={`rounded-2xl border-2 bg-card p-4 ${expandable && !props.open ? "cursor-pointer hover:bg-accent" : ""}`}
      style={{ borderColor: COMPANY_PANEL_COLORS.decision }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <b className="text-sm font-semibold">
          Decisiones
          <Stale kind="decisions" section={snapshot.decisions} />
        </b>
        {expandable ? (
          <button
            type="button"
            aria-expanded={props.open}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle();
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {props.open ? "Cerrar" : "Pulsa"}
          </button>
        ) : null}
      </div>
      {snapshot.decisions.status === "ok" ? (
        <>
          <span
            className="text-4xl leading-none font-bold"
            style={{ color: COMPANY_PANEL_COLORS.decision }}
          >
            {pending.length}
          </span>{" "}
          <Sub2>{pending.length === 1 ? "pendiente" : "pendientes"}</Sub2>
        </>
      ) : null}
      {props.open || first === undefined ? (
        <PendingDecision snapshot={snapshot} busy={props.busy} onAnswer={props.onAnswer} />
      ) : (
        <>
          <p className="mt-3.5 text-sm leading-snug font-semibold">{first.title}</p>
          <div className="mt-1.5">
            <Sub>
              {first
                ? (companyDecisionSealText(first) ?? "Faltan las opiniones de los hilos")
                : null}
            </Sub>
          </div>
        </>
      )}
    </section>
  );
}

function HomeTab(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onOpenDecision: () => void;
}) {
  const { snapshot } = props;
  const costs = snapshot.costs.status === "ok" ? snapshot.costs.data : null;
  const [wantsOpen, setWantsOpen] = useState(false);
  // Answering the last one leaves nothing to show large, so the layout goes back on its own.
  const decisionOpen = wantsOpen && pendingCompanyDecisions(snapshot).length > 0;
  return (
    <div
      className={`grid grid-cols-1 items-start gap-4 ${decisionOpen ? "" : "@xl/company:grid-cols-[minmax(0,1fr)_minmax(12rem,25%)]"}`}
    >
      <div className="grid min-w-0 gap-4">
        <CostBlock snapshot={snapshot} />
        <Block title="Simulador de coste">{costs ? <Simulator costs={costs} /> : <NoData />}</Block>
        <PlansBlock snapshot={snapshot} />
        <ThreadsBlock snapshot={snapshot} />
        <DatabaseBlock snapshot={snapshot} />
        <TestsAndErrorsBlock snapshot={snapshot} />
        <SystemStrip snapshot={snapshot} />
      </div>
      <aside className={`min-w-0 order-first ${decisionOpen ? "" : "@xl/company:order-none"}`}>
        <DecisionsBlock
          snapshot={snapshot}
          open={decisionOpen}
          busy={props.busy}
          onAnswer={props.onAnswer}
          onToggle={() => {
            if (!decisionOpen) props.onOpenDecision();
            setWantsOpen(!decisionOpen);
          }}
        />
      </aside>
    </div>
  );
}

function DecisionsTab(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { snapshot } = props;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PendingDecision snapshot={snapshot} busy={props.busy} onAnswer={props.onAnswer} />
      {pendingCompanyDecisions(snapshot).length > 1 ? (
        <Sub>Quedan {pendingCompanyDecisions(snapshot).length - 1} más después de esta.</Sub>
      ) : null}
      {snapshot.answered.length > 0 ? (
        <div>
          <Label>Ya contestadas</Label>
          <div className="mt-1.5 space-y-1 text-xs">
            {snapshot.answered.toReversed().map((answered) => (
              <div
                key={answered.decisionId}
                className="flex justify-between gap-3 rounded-lg border border-border bg-card px-2.5 py-1.5"
              >
                <span>
                  <b>{answered.title ?? answered.decisionId}</b> · {answered.answer}
                </span>
                <span className="flex-none text-muted-foreground">{answered.person}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CostHistory({ costs }: { costs: CompanyPanelCostsFile }) {
  const points = costs.perPerson.slice(-4);
  const names = [...new Set(points.flatMap((point) => point.parts.map((part) => part.name)))];
  return (
    <table className="mt-2 w-full border-collapse text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="border-b border-border p-1.5 text-left font-normal">Parte</th>
          {points.map((point) => (
            <th key={point.date} className="border-b border-border p-1.5 text-right font-normal">
              {point.date}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {names.map((name) => (
          <tr key={name}>
            <td className="border-b border-border p-1.5">{name}</td>
            {points.map((point) => {
              const part = point.parts.find((candidate) => candidate.name === name);
              return (
                <td key={point.date} className="border-b border-border p-1.5 text-right font-mono">
                  {part ? money(part.amount, costs.currency) : "—"}
                </td>
              );
            })}
          </tr>
        ))}
        <tr className="font-semibold">
          <td className="p-1.5">Total</td>
          {points.map((point) => (
            <td key={point.date} className="p-1.5 text-right font-mono">
              {money(point.total, costs.currency)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function SpendChart({ costs }: { costs: CompanyPanelCostsFile }) {
  const days = costs.spendLast30Days;
  if (!days) return <NoData what="gasto de 30 días" />;
  const max = Math.max(...days.map((day) => day.amount), 1);
  return (
    <div className="mt-2 flex h-24 items-end gap-0.5">
      {days.map((day) => (
        <Hint key={day.date} text={`${day.date}: ${money(day.amount, costs.currency)}`}>
          <div
            style={{ height: `${Math.max((day.amount / max) * 100, 2)}%` }}
            className="flex-1 rounded-t-xs bg-primary opacity-70 hover:opacity-100 hover:outline hover:outline-foreground"
          />
        </Hint>
      ))}
    </div>
  );
}

function CostsTab({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  if (snapshot.costs.status !== "ok") {
    return <NoData broken={snapshot.costs.status === "invalid"} what="costes" />;
  }
  const costs = snapshot.costs.data;
  const trend = costTrend(costs.perPerson);
  return (
    <div className="grid grid-cols-1 gap-2 @xl/company:grid-cols-2">
      <Tile>
        <Label>
          Coste por persona · regla D205 · {costs.daysPerMonth} días
          <Stale kind="costs" section={snapshot.costs} />
        </Label>
        <CostSummary costs={costs} />
        <CostBars costs={costs} />
        {trend?.sinceLast ? (
          <Sub>
            {trend.sinceLast.amount === 0
              ? `Igual que el ${trend.sinceLast.date}`
              : `${trend.sinceLast.amount < 0 ? "Bajó" : "Subió"} ${money(Math.abs(trend.sinceLast.amount), costs.currency)} desde el ${trend.sinceLast.date}`}
            {trend.latest.release ? ` · ${trend.latest.release}` : ""}
          </Sub>
        ) : null}
      </Tile>
      <Tile>
        <Label>De qué está hecho</Label>
        <CostHistory costs={costs} />
      </Tile>
      <Tile className="@xl/company:col-span-2">
        <Label>¿Y si…? · simulador de coste</Label>
        <Simulator costs={costs} />
      </Tile>
      <Tile className="@xl/company:col-span-2">
        <Label>Gasto real, últimos 30 días</Label>
        <Sub>Es lo que se ha gastado de verdad. No es el coste por persona.</Sub>
        <SpendChart costs={costs} />
      </Tile>
    </div>
  );
}

function JobRow({ job }: { job: NonNullable<CompanyPanelTestsFile["jobs"]>[number] }) {
  const [open, setOpen] = useState(false);
  const kind = companyPanelJobKind(job);
  const state = companyPanelJobState(job);
  const entry = COMPANY_PANEL_JOB_KINDS.find((candidate) => candidate.kind === kind);
  return (
    <button
      type="button"
      onClick={() => setOpen((current) => !current)}
      className="flex w-full gap-2 rounded-lg border border-border bg-background p-2 text-left hover:bg-accent"
    >
      <span className={`w-1 flex-none self-stretch rounded-full ${TONE_BG[KIND_TONE[kind]]}`} />
      <span className="min-w-0 flex-1">
        <span className={open ? "block" : "block truncate"}>{job.message}</span>
        <span className="text-2xs text-muted-foreground">{entry?.label}</span>
        {open ? (
          <span className="mt-1 block space-y-0.5 text-xs text-muted-foreground">
            {job.before ? <span className="block">Antes: {job.before}</span> : null}
            {state.note ? <span className="block">Ahora: {state.note}</span> : null}
            {job.why ? <span className="block">Por qué: {job.why}</span> : null}
            {job.version ? <span className="block">Versión {job.version}</span> : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Every battery with its bar, then what is and is not done; pressing a row shows why. */
function JobsLog({ tests }: { tests: CompanyPanelTestsFile }) {
  const [suite, setSuite] = useState<string | null>(null);
  const [kind, setKind] = useState<CompanyPanelJobKind | null>(null);
  const jobs = tests.jobs;
  if (!jobs) return <NoData what="registro de encargos" />;
  const inSuite = suite === null ? jobs : jobs.filter((job) => job.suite === suite);
  const tally = companyPanelJobTally(inSuite);
  const shown = companyPanelJobsByUrgency(
    kind === null ? inSuite : inSuite.filter((job) => companyPanelJobKind(job) === kind),
  );
  return (
    <div className="mt-3 text-xs">
      <div className="space-y-1">
        {companyPanelSuites(jobs).map((entry) => (
          <button
            type="button"
            key={entry.name}
            onClick={() => setSuite((current) => (current === entry.name ? null : entry.name))}
            className={`grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent ${suite === entry.name ? "bg-accent" : ""}`}
          >
            <span className="truncate">{entry.name}</span>
            <TallyBar tally={entry.tally} />
            <span className="font-mono text-muted-foreground">
              {entry.tally.done}/{entry.total}
            </span>
          </button>
        ))}
      </div>
      <div className="my-2 flex flex-wrap gap-1">
        {COMPANY_PANEL_JOB_KINDS.filter((entry) => tally[entry.kind] > 0).map((entry) => (
          <button
            type="button"
            key={entry.kind}
            onClick={() => setKind((current) => (current === entry.kind ? null : entry.kind))}
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${kind === entry.kind ? "border-foreground" : "border-border"}`}
          >
            <span className={`size-2 rounded-full ${TONE_BG[entry.tone]}`} />
            {entry.label} · {tally[entry.kind]}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        {shown.map((job) => (
          <JobRow key={`${job.suite ?? ""}:${job.message}`} job={job} />
        ))}
      </div>
    </div>
  );
}

function HealthTab({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  return (
    <div className="grid grid-cols-1 gap-2">
      <Tile>
        <Label>
          Versiones y salud del sistema
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? (
          <VersionsAndHealth health={health} />
        ) : (
          <NoData broken={snapshot.health.status === "invalid"} />
        )}
      </Tile>
      <Tile>
        <Label>
          Errores, último mes
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? <ErrorHeat health={health} /> : <NoData />}
      </Tile>
      <Tile>
        <Label>
          Pruebas reales y registro de encargos
          <Stale kind="tests" section={snapshot.tests} />
        </Label>
        {tests ? (
          <>
            <TestsLine tests={tests} />
            <JobsLog tests={tests} />
          </>
        ) : (
          <NoData broken={snapshot.tests.status === "invalid"} />
        )}
      </Tile>
    </div>
  );
}

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: "home", label: "Inicio" },
  { id: "decisions", label: "Decisiones" },
  { id: "costs", label: "Costes" },
  { id: "health", label: "Salud" },
];

export function CompanyPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(companyPanelEnvironment.snapshot({ environmentId, input: {} }));
  const answerCommand = useAtomCommand(companyPanelEnvironment.answer, "Contestar la decisión");
  const [tab, setTab] = useState<Tab>("home");
  const scroller = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = query;

  useEffect(() => {
    const interval = setInterval(refresh, COMPANY_PANEL_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const snapshot = query.data;
  const onAnswer: AnswerFn = (decisionId, answer) => {
    setBusy(true);
    void answerCommand({ environmentId, input: { decisionId, answer } }).finally(() => {
      setBusy(false);
      refresh();
    });
  };

  return (
    <FetchedAtContext value={query.dataUpdatedAt}>
      <div className="@container/company h-full bg-background text-sm text-foreground">
        <div ref={scroller} className="h-full overflow-auto p-4">
          <div className="mb-4 flex gap-1 text-sm">
            {TABS.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`rounded-full border px-3 py-1 ${tab === item.id ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {item.label}
                {item.id === "decisions" && snapshot ? (
                  <CountBadge count={pendingCompanyDecisions(snapshot).length} />
                ) : null}
              </button>
            ))}
          </div>
          {snapshot === null ? (
            <NoData {...(query.error ? { what: query.error } : {})} />
          ) : !snapshot.available ? (
            <NoData what="este panel no está disponible para ti" />
          ) : tab === "home" ? (
            <HomeTab
              snapshot={snapshot}
              busy={busy}
              onAnswer={onAnswer}
              onOpenDecision={() => scroller.current?.scrollTo({ top: 0 })}
            />
          ) : tab === "decisions" ? (
            <DecisionsTab snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
          ) : tab === "costs" ? (
            <CostsTab snapshot={snapshot} />
          ) : (
            <HealthTab snapshot={snapshot} />
          )}
        </div>
      </div>
    </FetchedAtContext>
  );
}
