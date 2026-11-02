/**
 * Necode: the company panel, a right-panel app to see the state of the company and answer its
 * decisions without asking a thread. Everything shown comes from the server's panel snapshot; what
 * has no data says so ("Sin dato"), never a zero.
 */
import {
  COMPANY_DATABASE_SENTENCE,
  COMPANY_PANEL_JOB_KINDS,
  COMPANY_PANEL_REFRESH_MS,
  companyCacheView,
  companyDatabaseView,
  companyPanelJobKind,
  companyPanelJobsByUrgency,
  companyPanelJobTally,
  companyPanelShortDate,
  companyPanelShortLabel,
  companyPanelSuites,
  companyThreadStatusView,
  companyDecisionConsensus,
  companyDecisionOptionIndex,
  companyDecisionOptionLetter,
  companyDecisionSwipeAction,
  companyDecisionTime,
  companyPanelJobState,
  companyPanelStaleLabel,
  costTrend,
  pendingCompanyDecisions,
  simulateMonthlyCost,
} from "@t3tools/client-runtime/state/company-panel";
import type {
  CompanyPanelDataKind,
  CompanyPanelJobKind,
  CompanyPanelJobTally,
  CompanyPanelTone,
} from "@t3tools/client-runtime/state/company-panel";
import type {
  CompanyPanelAnswer,
  CompanyPanelCostsFile,
  CompanyPanelDecision,
  CompanyPanelHealthFile,
  CompanyPanelSnapshot,
  CompanyPanelSystemStatus,
  CompanyPanelTestsFile,
  EnvironmentId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { companyPanelEnvironment } from "~/state/companyPanel";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Tab = "home" | "decisions" | "costs" | "health";
type Detail =
  | "decision"
  | "costs"
  | "cache"
  | "versions"
  | "database"
  | "threads"
  | "errors"
  | "tests";

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
  readonly section: CompanyPanelSnapshot["health" | "costs" | "tests" | "decisions"];
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
const NoData = ({ what, broken }: { what?: string; broken?: boolean }) => (
  <div className="mt-2 text-xs text-muted-foreground italic">
    {broken ? "Dato ilegible" : "Sin dato"}
    {what ? ` · ${what}` : ""}
  </div>
);

function Tile(props: {
  readonly className?: string;
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}) {
  const shared = `group relative rounded-xl border border-border bg-card p-3 text-left ${props.className ?? ""}`;
  if (!props.onOpen) return <div className={shared}>{props.children}</div>;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") props.onOpen?.();
      }}
      className={`${shared} cursor-pointer transition-[transform,border-color,background-color] duration-150 hover:-translate-y-0.5 hover:border-ring hover:bg-accent focus-visible:border-ring focus-visible:outline-none`}
    >
      <span className="absolute top-2 right-3 text-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        ↗
      </span>
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
      {label}: <b className="text-foreground">{value}</b>
      <input
        type="range"
        className="mt-1 w-full accent-primary"
        min={input.min}
        max={input.max}
        step={input.step}
        value={input.value}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => input.set(Number(event.target.value))}
      />
    </label>
  );
  return (
    <div className="mt-1.5 grid grid-cols-1 items-end gap-3.5 @xl/company:grid-cols-[1fr_1fr_1fr_130px]">
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
      <div>
        <Sub>Al mes</Sub>
        <div className="font-mono text-2xl">{money(total, costs.currency)}</div>
      </div>
    </div>
  );
}

function ErrorHeat({ health }: { health: CompanyPanelHealthFile }) {
  const days = health.errorsByDay;
  if (!days) return <NoData what="errores por día" />;
  const max = Math.max(...days.map((day) => day.count), 1);
  return (
    <div className="mt-2 grid grid-cols-[repeat(15,1fr)] gap-0.5">
      {days.map((day) => (
        <Hint
          key={day.date}
          text={`${day.date}: ${day.count} ${day.count === 1 ? "error" : "errores"}${day.detail ? ` · ${day.detail}` : ""}`}
        >
          <div
            style={{ opacity: day.count === 0 ? 0.35 : 0.5 + (day.count / max) * 0.5 }}
            className={`aspect-square rounded-xs hover:outline hover:outline-foreground ${
              day.count === 0
                ? "bg-success"
                : day.count / max > 0.5
                  ? "bg-destructive"
                  : "bg-warning"
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

const OPTION_LETTER_STYLE = [
  "bg-primary text-white",
  "bg-warning text-white",
  "bg-foreground text-background",
  "bg-destructive text-white",
];

function OptionLetter({ index }: { index: number | null }) {
  if (index === null) return <span className="size-5 flex-none text-center">—</span>;
  return (
    <span
      className={`flex size-5 flex-none items-center justify-center rounded-full text-xs font-semibold ${OPTION_LETTER_STYLE[index % OPTION_LETTER_STYLE.length]}`}
    >
      {companyDecisionOptionLetter(index)}
    </span>
  );
}

const Missing = ({ children }: { children: ReactNode }) => (
  <div className="mt-1 text-xs text-warning italic">{children}</div>
);

function ConsensusSeal({ decision }: { decision: CompanyPanelDecision }) {
  const consensus = companyDecisionConsensus(decision);
  if (consensus === null) return <Missing>Faltan las opiniones de los hilos.</Missing>;
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-success/15 px-2.5 py-1.5 text-xs">
      <span className="flex flex-none gap-1">
        {Array.from({ length: consensus.total }, (_, index) => (
          <span
            key={index}
            className={`size-2 rounded-full ${index < consensus.count ? "bg-success" : "bg-muted-foreground/40"}`}
          />
        ))}
      </span>
      {consensus.optionIndex === null
        ? `Los hilos no se ponen de acuerdo (${consensus.total})`
        : `${consensus.count} de ${consensus.total} hilos recomiendan la opción ${companyDecisionOptionLetter(consensus.optionIndex)}`}
    </div>
  );
}

function DecisionRow(props: {
  readonly name: string;
  readonly letter: number | null;
  readonly reason: string;
  readonly source?: string | undefined;
  /** Threads speak for themselves; only what others do needs a source. */
  readonly needsSource?: boolean;
}) {
  const link = props.source !== undefined && /^https?:\/\//.test(props.source);
  return (
    <div className="flex gap-2 py-1 text-xs">
      <OptionLetter index={props.letter} />
      <div className="min-w-0">
        <b>{props.name}</b> · {props.reason}
        {props.source === undefined ? (
          props.needsSource === false ? null : (
            <span className="text-warning italic"> · sin fuente</span>
          )
        ) : link ? (
          <>
            {" · "}
            <a href={props.source} target="_blank" rel="noreferrer" className="underline">
              Fuente
            </a>
          </>
        ) : (
          ` · ${props.source}`
        )}
      </div>
    </div>
  );
}

/** One decision, in the order Roi approved. Drag right, left or up does what the swipe says. */
function DecisionCard(props: {
  readonly decision: CompanyPanelDecision;
  readonly position: number;
  readonly total: number;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  /** Where the card is small: pressing anywhere that is not a control opens it large. */
  readonly onOpen?: (() => void) | undefined;
}) {
  const { decision } = props;
  const [explained, setExplained] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // A drag ends in a click too; that click must not open the card.
  const dragged = useRef(false);
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
    if (Math.hypot(moved.x, moved.y) > 8) dragged.current = true;
    const swipe = moved.x > 90 ? "right" : moved.x < -90 ? "left" : moved.y < -70 ? "up" : null;
    if (swipe === null) return;
    const action = companyDecisionSwipeAction(decision, swipe);
    if (action === "write") setWriting(true);
    else if (action !== null) props.onAnswer(decision.id, action);
  };

  return (
    <div
      onClick={(event) => {
        event.stopPropagation();
        const wasDragged = dragged.current;
        dragged.current = false;
        if (wasDragged || (event.target as HTMLElement).closest("button,textarea,a")) return;
        props.onOpen?.();
      }}
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
      className={`flex touch-pan-y flex-col rounded-xl border border-border bg-background p-3 text-sm ${props.onOpen ? "cursor-pointer transition-colors hover:border-ring" : ""}`}
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
          options.map((option, index) => (
            <button
              type="button"
              key={option.id}
              disabled={props.busy}
              className={`flex w-full gap-2 rounded-lg border p-2.5 text-left transition-colors hover:bg-accent disabled:opacity-50 ${option.recommended ? "border-success" : "border-border"}`}
              onClick={() => props.onAnswer(decision.id, { type: "option", optionId: option.id })}
            >
              <OptionLetter index={index} />
              <span className="min-w-0">
                <span className="font-medium">{option.label}</span>
                {option.recommended ? (
                  <span className="block text-xs text-success">Recomendada</span>
                ) : null}
                {option.effect ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.effect}
                  </span>
                ) : null}
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

      <div className="mt-3">
        <Label>Qué opinan los hilos</Label>
      </div>
      {decision.opinions?.length ? (
        decision.opinions.map((opinion) => (
          <DecisionRow
            key={opinion.thread}
            name={opinion.thread}
            letter={companyDecisionOptionIndex(decision, opinion.optionId)}
            reason={opinion.opinion}
            needsSource={false}
          />
        ))
      ) : (
        <Missing>Falta: ningún hilo ha dado su opinión.</Missing>
      )}

      <div className="mt-3">
        <Label>Cómo lo hacen otros</Label>
      </div>
      {decision.references?.length ? (
        decision.references.map((reference) => (
          <DecisionRow
            key={reference.name}
            name={reference.name}
            letter={companyDecisionOptionIndex(decision, reference.optionId)}
            reason={reference.how}
            source={reference.source}
          />
        ))
      ) : (
        <Missing>Falta: nadie ha mirado cómo lo hacen otros.</Missing>
      )}
    </div>
  );
}

function PendingDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onOpen?: (() => void) | undefined;
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
        onOpen={props.onOpen}
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

function ThreadsList({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  if (snapshot.threads.length === 0) return <NoData what="hilos" />;
  return (
    <div className="mt-1.5 space-y-1 text-xs">
      {snapshot.threads.map((thread) => {
        const view = companyThreadStatusView(thread.status);
        return (
          <Hint key={thread.name} text={`${thread.name}: ${view.label}`}>
            <div className="flex items-center gap-1.5">
              <span className={`size-2 flex-none rounded-full ${TONE_BG[view.tone]}`} />
              <span className="min-w-0 flex-1 truncate">{thread.name}</span>
              <span className="flex-none text-muted-foreground">{view.label}</span>
            </div>
          </Hint>
        );
      })}
    </div>
  );
}

function CacheView({ percent }: { percent: number }) {
  const view = companyCacheView(percent);
  return (
    <>
      <Big>{Math.round(percent)} %</Big>
      <div className="my-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${TONE_BG[view.tone]}`} style={{ width: `${percent}%` }} />
      </div>
      <Sub>{view.sentence}</Sub>
    </>
  );
}

function DatabaseView({ health }: { health: CompanyPanelHealthFile }) {
  const { database } = health;
  if (!database) return <NoData />;
  const view = companyDatabaseView(database);
  return (
    <>
      <Big>{Math.round(database.readGbPerDay)} GB</Big>
      {view ? (
        <div className="my-1.5 h-2 overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${TONE_BG[view.tone]}`} style={{ width: `${view.percent}%` }} />
        </div>
      ) : null}
      <Sub>{COMPANY_DATABASE_SENTENCE}</Sub>
      {view ? null : <NoData what="falta un límite para saber si es mucho" />}
    </>
  );
}

function HomeTab(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onDetail: (detail: Detail) => void;
}) {
  const { snapshot, onDetail } = props;
  const costs = snapshot.costs.status === "ok" ? snapshot.costs.data : null;
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  const staging = health?.versions.find((version) => /staging/i.test(version.environment));
  return (
    <div className="grid auto-rows-[minmax(104px,auto)] grid-cols-2 gap-2 @xl/company:grid-cols-4">
      <Tile className="col-span-2" onOpen={() => onDetail("costs")}>
        <Label>
          Coste por persona{costs ? ` · ${costs.daysPerMonth} días` : ""}
          <Stale kind="costs" section={snapshot.costs} />
        </Label>
        {costs ? (
          <>
            <CostSummary costs={costs} />
            <CostBars costs={costs} />
          </>
        ) : (
          <NoData broken={snapshot.costs.status === "invalid"} />
        )}
      </Tile>
      <Tile onOpen={() => onDetail("cache")}>
        <Label>
          Caché
          <Stale kind="costs" section={snapshot.costs} />
        </Label>
        {costs?.cache ? <CacheView percent={costs.cache.percent} /> : <NoData />}
      </Tile>
      <Tile
        className="relative col-span-2 row-auto flex flex-col border-ring bg-accent @xl/company:col-span-1 @xl/company:col-start-4 @xl/company:row-span-3 @xl/company:row-start-1"
        {...(pendingCompanyDecisions(snapshot).length > 0
          ? { onOpen: () => onDetail("decision") }
          : {})}
      >
        {/* The column keeps the height of the blocks beside it; a long card scrolls inside. */}
        <div className="@xl/company:absolute @xl/company:inset-3 @xl/company:overflow-y-auto">
          <Label>
            Decisiones <CountBadge count={pendingCompanyDecisions(snapshot).length} />
            <Stale kind="decisions" section={snapshot.decisions} />
          </Label>
          <PendingDecision
            snapshot={snapshot}
            busy={props.busy}
            onAnswer={props.onAnswer}
            onOpen={() => onDetail("decision")}
          />
        </div>
      </Tile>
      <Tile onOpen={() => onDetail("versions")}>
        <Label>
          Última versión
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {staging ? (
          <>
            <div className="mt-1.5 truncate font-mono text-2xl leading-tight">
              {staging.version}
            </div>
            <Sub>{staging.environment}</Sub>
          </>
        ) : (
          <NoData broken={snapshot.health.status === "invalid"} />
        )}
      </Tile>
      <Tile onOpen={() => onDetail("database")}>
        <Label>
          Base de datos
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? <DatabaseView health={health} /> : <NoData />}
      </Tile>
      <Tile onOpen={() => onDetail("threads")}>
        <Label>Hilos, ahora</Label>
        <ThreadsList snapshot={snapshot} />
      </Tile>
      <Tile className="col-span-2 @xl/company:col-span-3" onOpen={() => onDetail("costs")}>
        <Label>¿Y si…? · simulador de coste</Label>
        {costs ? <Simulator costs={costs} /> : <NoData />}
      </Tile>
      <Tile className="col-span-2" onOpen={() => onDetail("errors")}>
        <Label>
          Errores, último mes
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? (
          <ErrorHeat health={health} />
        ) : (
          <NoData broken={snapshot.health.status === "invalid"} />
        )}
      </Tile>
      <Tile className="col-span-2" onOpen={() => onDetail("tests")}>
        <Label>
          Pruebas reales
          <Stale kind="tests" section={snapshot.tests} />
        </Label>
        {tests ? (
          <TestsLine tests={tests} />
        ) : (
          <NoData broken={snapshot.tests.status === "invalid"} />
        )}
      </Tile>
      <Tile className="col-span-full" onOpen={() => onDetail("versions")}>
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

/** The publisher's own words, for whoever wants them; they stay folded. */
function TechnicalDetail({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Detalle técnico</summary>
      <p className="mt-1 whitespace-pre-line">{text}</p>
    </details>
  );
}

function DetailView({
  detail,
  snapshot,
  busy,
  onAnswer,
}: {
  detail: Detail;
  snapshot: CompanyPanelSnapshot;
  busy: boolean;
  onAnswer: AnswerFn;
}) {
  const costs = snapshot.costs.status === "ok" ? snapshot.costs.data : null;
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  switch (detail) {
    case "decision":
      return (
        <div className="mx-auto max-w-2xl pt-6">
          <PendingDecision snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
        </div>
      );
    case "costs":
      return <CostsTab snapshot={snapshot} />;
    case "cache":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Caché</h3>
          {costs?.cache ? <CacheView percent={costs.cache.percent} /> : <NoData />}
        </>
      );
    case "versions":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Versiones y salud</h3>
          {health ? (
            <>
              <VersionsAndHealth health={health} />
              <TechnicalDetail
                text={[
                  ...health.versions.flatMap((version) =>
                    version.detail ? [`${version.environment}: ${version.detail}`] : [],
                  ),
                  ...health.systems.flatMap((system) =>
                    system.detail ? [`${system.name}: ${system.detail}`] : [],
                  ),
                ].join("\n")}
              />
            </>
          ) : (
            <NoData />
          )}
        </>
      );
    case "database":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Base de datos</h3>
          {health ? <DatabaseView health={health} /> : <NoData />}
          <TechnicalDetail text={health?.database?.detail} />
        </>
      );
    case "threads":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Hilos</h3>
          <ThreadsList snapshot={snapshot} />
        </>
      );
    case "errors":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Errores</h3>
          {health?.errorsByDay ? (
            <>
              <ErrorHeat health={health} />
              <div className="mt-3 space-y-1 text-xs">
                {health.errorsByDay
                  .toReversed()
                  .filter((day) => day.count > 0)
                  .map((day) => (
                    <div key={day.date}>
                      <b>{day.date}</b> · {day.count} {day.detail ? `· ${day.detail}` : ""}
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <NoData />
          )}
        </>
      );
    case "tests":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Pruebas reales</h3>
          {tests ? (
            <>
              <TestsLine tests={tests} />
              <JobsLog tests={tests} />
              <TechnicalDetail text={tests.label} />
            </>
          ) : (
            <NoData />
          )}
        </>
      );
  }
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
  const [detail, setDetail] = useState<Detail | null>(null);
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
      <div className="@container/company relative h-full bg-background text-sm text-foreground">
        {/* The detail sits outside the scroller, so it opens in view from any scroll position. */}
        <div className="h-full overflow-auto p-3">
          <div className="mb-2.5 flex gap-1 text-sm">
            {TABS.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setTab(item.id);
                  setDetail(null);
                }}
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
            <HomeTab snapshot={snapshot} busy={busy} onAnswer={onAnswer} onDetail={setDetail} />
          ) : tab === "decisions" ? (
            <DecisionsTab snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
          ) : tab === "costs" ? (
            <CostsTab snapshot={snapshot} />
          ) : (
            <HealthTab snapshot={snapshot} />
          )}
        </div>
        {detail !== null && snapshot !== null ? (
          <div className="absolute inset-2 z-10 overflow-auto transition starting:scale-95 starting:opacity-0 rounded-xl border border-ring bg-popover p-4 duration-200">
            <button
              type="button"
              aria-label="Cerrar"
              onClick={() => setDetail(null)}
              className="absolute top-3 right-3 z-10 rounded-lg bg-muted p-1.5"
            >
              <XIcon className="size-3.5" />
            </button>
            <DetailView detail={detail} snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
          </div>
        ) : null}
      </div>
    </FetchedAtContext>
  );
}
