/**
 * Necode: the company panel, a right-panel app to see the state of the company and answer its
 * decisions without asking a thread. Everything shown comes from the server's panel snapshot; what
 * has no data says so ("Sin dato"), never a zero.
 */
import {
  COMPANY_PANEL_REFRESH_MS,
  companyPanelJobState,
  companyPanelStaleLabel,
  costTrend,
  pendingCompanyDecisions,
  simulateMonthlyCost,
} from "@t3tools/client-runtime/state/company-panel";
import type { CompanyPanelDataKind } from "@t3tools/client-runtime/state/company-panel";
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
type Detail = "costs" | "cache" | "versions" | "database" | "threads" | "errors" | "tests";

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

function CostBars({ costs }: { costs: CompanyPanelCostsFile }) {
  const max = Math.max(...costs.perPerson.map((point) => point.total), 1);
  return (
    <div className="mt-2 flex h-14 items-end gap-1.5">
      {costs.perPerson.map((point, index) => (
        <Hint key={point.date} text={`${point.date}: ${money(point.total, costs.currency)}`}>
          <div
            style={{ height: `${Math.max((point.total / max) * 100, 4)}%` }}
            className={`flex-1 rounded-t-sm hover:opacity-100 hover:outline hover:outline-foreground ${
              index === costs.perPerson.length - 1 ? "bg-success" : "bg-primary opacity-55"
            }`}
          />
        </Hint>
      ))}
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
        {percent === null ? "" : `desde el ${costs.perPerson[0]?.date} · `}se recalcula solo
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
            {version.detail ? <Sub>{version.detail}</Sub> : null}
          </div>
        ))}
      </div>
      <SystemsGrid health={health} />
    </div>
  );
}

const TestsLine = ({ tests }: { tests: CompanyPanelTestsFile }) => (
  <>
    <div className="mt-1.5 font-mono text-2xl leading-tight">
      ✅ {tests.passed} · ❌ {tests.failed} · ⚪ {tests.skipped}
    </div>
    <Sub>{tests.label}</Sub>
  </>
);

type AnswerFn = (decisionId: string, answer: CompanyPanelAnswer) => void;

/** One decision: right is yes, left is no, up is "something else". Buttons do the same. */
function DecisionCard(props: {
  readonly decision: CompanyPanelDecision;
  readonly large?: boolean;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { decision } = props;
  const [explained, setExplained] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const options = decision.options ?? [];
  const canSwipe = options.length === 0;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canSwipe || writing || (event.target as HTMLElement).closest("button,textarea,a")) return;
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
    if (moved.x > 90) props.onAnswer(decision.id, { type: "yes" });
    else if (moved.x < -90) props.onAnswer(decision.id, { type: "no" });
    else if (moved.y < -70) setWriting(true);
  };

  const hasExplanation =
    decision.problem ||
    decision.example ||
    decision.opinions?.length ||
    decision.references?.length;

  return (
    <div
      onClick={(event) => event.stopPropagation()}
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
      className={`flex flex-col rounded-xl border border-border bg-background p-2.5 ${canSwipe ? "touch-pan-y" : ""} ${props.large ? "p-4 text-sm" : "text-xs"}`}
    >
      <b className={props.large ? "mb-1 text-base" : "mb-1 text-sm"}>{decision.title}</b>
      <div>{decision.summary}</div>

      {explained ? (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {decision.problem ? <p>{decision.problem}</p> : null}
          {decision.example ? (
            <p>
              <b>Ejemplo:</b> {decision.example}
            </p>
          ) : null}
          {decision.opinions?.length ? (
            <div>
              <b>Qué opina cada hilo</b>
              {decision.opinions.map((opinion) => (
                <div key={opinion.thread}>
                  {opinion.thread}: {opinion.opinion}
                </div>
              ))}
            </div>
          ) : null}
          {decision.references?.length ? (
            <div>
              <b>Cómo lo hacen otros</b>
              {decision.references.map((reference) => (
                <div key={reference.name}>
                  {reference.name}: {reference.how}
                  {reference.source ? ` (${reference.source})` : ""}
                </div>
              ))}
            </div>
          ) : null}
          {hasExplanation ? null : <NoData what="explicación" />}
        </div>
      ) : null}

      {writing ? (
        <div className="mt-2">
          <textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Escribe lo que quieras decidir…"
            className="min-h-16 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground outline-none focus:border-ring"
          />
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              className="rounded-lg border border-border bg-card p-1.5"
              onClick={() => setWriting(false)}
            >
              Volver
            </button>
            <button
              type="button"
              disabled={props.busy || text.trim() === ""}
              className="rounded-lg border border-success bg-success/15 p-1.5 disabled:opacity-50"
              onClick={() => props.onAnswer(decision.id, { type: "other", text: text.trim() })}
            >
              Enviar
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {options.length > 0 ? (
            options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={props.busy}
                className={`col-span-2 rounded-lg border p-1.5 disabled:opacity-50 ${option.recommended ? "border-success bg-success/15" : "border-border bg-card"}`}
                onClick={() => props.onAnswer(decision.id, { type: "option", optionId: option.id })}
              >
                {option.label}
                {option.recommended ? " · recomendada" : ""}
              </button>
            ))
          ) : (
            <>
              <button
                type="button"
                disabled={props.busy}
                className="rounded-lg border border-destructive bg-destructive/15 p-1.5 disabled:opacity-50"
                onClick={() => props.onAnswer(decision.id, { type: "no" })}
              >
                ← No
              </button>
              <button
                type="button"
                disabled={props.busy}
                className="rounded-lg border border-success bg-success/15 p-1.5 disabled:opacity-50"
                onClick={() => props.onAnswer(decision.id, { type: "yes" })}
              >
                Sí →
              </button>
            </>
          )}
          <button
            type="button"
            className="col-span-2 rounded-lg border border-border bg-card p-1.5"
            onClick={() => setWriting(true)}
          >
            ↑ Otra cosa
          </button>
          <button
            type="button"
            className="col-span-2 rounded-lg border border-border bg-card p-1.5"
            onClick={() => setExplained((current) => !current)}
          >
            {explained ? "Ocultar" : "No lo entiendo"}
          </button>
        </div>
      )}
    </div>
  );
}

function PendingDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly large?: boolean;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const section = props.snapshot.decisions;
  if (section.status !== "ok")
    return <NoData broken={section.status === "invalid"} what="decisiones" />;
  const decision = section.data.decisions[0];
  if (decision === undefined) {
    return <div className="mt-2 text-xs text-muted-foreground">Sin decisiones pendientes.</div>;
  }
  return (
    <div className="mt-2">
      <DecisionCard
        key={decision.id}
        decision={decision}
        busy={props.busy}
        onAnswer={props.onAnswer}
        {...(props.large ? { large: true } : {})}
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
      {snapshot.threads.map((thread) => (
        <div key={thread.name} className="flex items-center justify-between gap-2">
          <span className="truncate">{thread.name}</span>
          <span className="text-muted-foreground">{thread.status}</span>
        </div>
      ))}
    </div>
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
        {costs?.cache ? (
          <>
            <Big>{Math.round(costs.cache.percent)} %</Big>
            {costs.cache.detail ? <Sub>{costs.cache.detail}</Sub> : null}
          </>
        ) : (
          <NoData />
        )}
      </Tile>
      <Tile className="col-span-2 row-auto flex flex-col border-ring bg-accent @xl/company:col-span-1 @xl/company:col-start-4 @xl/company:row-span-3 @xl/company:row-start-1">
        <Label>
          Decisiones <CountBadge count={pendingCompanyDecisions(snapshot).length} />
          <Stale kind="decisions" section={snapshot.decisions} />
        </Label>
        <PendingDecision snapshot={snapshot} busy={props.busy} onAnswer={props.onAnswer} />
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
          Base
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health?.database ? (
          <>
            <Big>{Math.round(health.database.readGbPerDay)} GB</Big>
            <Sub>leídos al día</Sub>
          </>
        ) : (
          <NoData />
        )}
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
      <PendingDecision large snapshot={snapshot} busy={props.busy} onAnswer={props.onAnswer} />
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

function JobsLog({ tests }: { tests: CompanyPanelTestsFile }) {
  const [suite, setSuite] = useState<string | null>(null);
  const jobs = tests.jobs;
  if (!jobs) return <NoData what="registro de encargos" />;
  const suites = [...new Set(jobs.flatMap((job) => (job.suite ? [job.suite] : [])))];
  const shown = suite === null ? jobs : jobs.filter((job) => job.suite === suite);
  return (
    <div className="mt-2">
      {suites.length > 1 ? (
        <div className="mb-2 flex flex-wrap gap-1 text-xs">
          {[null, ...suites].map((name) => (
            <button
              type="button"
              key={name ?? "all"}
              onClick={() => setSuite(name)}
              className={`rounded-full border px-2 py-0.5 ${suite === name ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`}
            >
              {name ?? "Todas"}
            </button>
          ))}
        </div>
      ) : null}
      <div className="space-y-1.5 text-xs">
        {shown.map((job) => {
          const state = companyPanelJobState(job);
          return (
            <div
              key={`${job.suite ?? ""}:${job.message}`}
              className="rounded-lg border border-border bg-background p-2"
            >
              <div>
                {state.icon} {job.message}
              </div>
              {job.before ? <Sub>Antes: {job.before}</Sub> : null}
              {state.note ? <Sub>Ahora: {state.note}</Sub> : null}
              {job.why ? <Sub>Por qué: {job.why}</Sub> : null}
              {job.version ? <Sub>Versión {job.version}</Sub> : null}
            </div>
          );
        })}
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

function DetailView({ detail, snapshot }: { detail: Detail; snapshot: CompanyPanelSnapshot }) {
  const costs = snapshot.costs.status === "ok" ? snapshot.costs.data : null;
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  switch (detail) {
    case "costs":
      return <CostsTab snapshot={snapshot} />;
    case "cache":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Caché</h3>
          {costs?.cache ? (
            <>
              <Big>{Math.round(costs.cache.percent)} %</Big>
              {costs.cache.detail ? <Sub>{costs.cache.detail}</Sub> : null}
            </>
          ) : (
            <NoData />
          )}
        </>
      );
    case "versions":
      return (
        <>
          <h3 className="mb-2 text-lg font-semibold">Versiones y salud</h3>
          {health ? (
            <>
              <VersionsAndHealth health={health} />
              <div className="mt-3 space-y-1 text-xs">
                {health.systems.map((system) => (
                  <div key={system.name} className="flex gap-2">
                    <span
                      className={`mt-1 size-2 flex-none rounded-full ${STATUS_DOT[system.status]}`}
                    />
                    <span>
                      <b>{system.name}</b> · {system.detail ?? STATUS_LABEL[system.status]}
                    </span>
                  </div>
                ))}
              </div>
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
          {health?.database ? (
            <>
              <Big>{Math.round(health.database.readGbPerDay)} GB</Big>
              <Sub>leídos al día</Sub>
              {health.database.detail ? (
                <p className="mt-2 text-sm">{health.database.detail}</p>
              ) : null}
            </>
          ) : (
            <NoData />
          )}
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
      <div className="@container/company relative h-full overflow-auto bg-background p-3 text-sm text-foreground">
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
            <DetailView detail={detail} snapshot={snapshot} />
          </div>
        ) : null}
      </div>
    </FetchedAtContext>
  );
}
