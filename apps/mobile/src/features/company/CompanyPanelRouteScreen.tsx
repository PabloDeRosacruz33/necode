/**
 * Necode: the company panel on the phone, to see the company's state and answer its decisions
 * without asking a thread. Same data as the desktop panel; what has no data says so, never a zero.
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
  companyDecisionCursor,
  companyDecisionMatrix,
  companyDecisionSealText,
  companyOptionSupport,
  companyDecisionSwipeAction,
  companyDecisionTime,
  companyPanelJobState,
  companyPanelStaleLabel,
  costTrend,
  pendingCompanyDecisions,
  simulateMonthlyCost,
} from "@t3tools/client-runtime/state/company-panel";
import type {
  CompanyDecisionCursor,
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
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, ScrollView, TextInput, View } from "react-native";
import Svg, { Circle, Line, Polyline, Text as SvgText } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { companyPanelEnvironment } from "../../state/companyPanel";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";

type Tab = "home" | "decisions" | "costs" | "health";
type AnswerFn = (decisionId: string, answer: CompanyPanelAnswer) => void;

const GREEN = "#22a06b";
const RED = "#e5484d";
const AMBER = "#f59e0b";
const BLUE = "#3f6fd1";
const STATUS_COLOR: Record<CompanyPanelSystemStatus, string> = {
  ok: GREEN,
  warning: AMBER,
  down: RED,
};

// Spanish leaves four digits ungrouped and Hermes has no way to ask otherwise: 1345 → 1.345.
const grouped = (text: string) => text.replace(/\b(\d)(\d{3})\b/, "$1.$2");

const money = (amount: number, currency: string) => {
  try {
    return grouped(
      new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount),
    );
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
};

/** When the shown snapshot was fetched, to tell how old each file is. */
const FetchedAtContext = createContext(0);

function Stale(props: {
  readonly kind: CompanyPanelDataKind;
  readonly section: NonNullable<
    CompanyPanelSnapshot["health" | "costs" | "tests" | "decisions" | "plans"]
  >;
}) {
  const label = companyPanelStaleLabel(props.kind, props.section, use(FetchedAtContext));
  return label === null ? null : <Text style={{ color: AMBER }}> · {label}</Text>;
}

const Label = ({ children }: { children: ReactNode }) => (
  <Text className="text-2xs tracking-[0.5px] uppercase text-foreground-muted">{children}</Text>
);
const Big = ({ children }: { children: ReactNode }) => (
  <Text className="mt-1 font-t3-medium text-3xl text-foreground">{children}</Text>
);
const Sub = ({ children }: { children: ReactNode }) => (
  <Text className="text-xs text-foreground-muted">{children}</Text>
);
const NoData = ({ what, broken }: { what?: string; broken?: boolean }) => (
  <Text className="mt-2 text-xs italic text-foreground-muted">
    {broken ? "Dato ilegible" : "Sin dato"}
    {what ? ` · ${what}` : ""}
  </Text>
);

/** A block; pressing it opens its detail in place. */
function Tile(props: {
  readonly className?: string;
  readonly detail?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      {props.children}
      {open ? <View className="mt-3 border-t border-separator pt-3">{props.detail}</View> : null}
    </>
  );
  const className = `rounded-2xl bg-grouped-card p-3 ${props.className ?? ""}`;
  if (!props.detail) return <View className={className}>{body}</View>;
  return (
    <Pressable className={className} onPress={() => setOpen((current) => !current)}>
      {body}
    </Pressable>
  );
}

const TONE_COLOR: Record<CompanyPanelTone, string> = {
  good: GREEN,
  warning: AMBER,
  bad: RED,
  active: BLUE,
  neutral: "#8888",
};
const PART_COLORS = [BLUE, AMBER, GREEN, "#8e4ec6", RED];

function SliceBar(props: {
  readonly slices: ReadonlyArray<{
    readonly key: string;
    readonly value: number;
    readonly color: string;
  }>;
}) {
  const total = props.slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return null;
  return (
    <View className="h-3 flex-row gap-0.5 overflow-hidden rounded-full">
      {props.slices
        .filter((slice) => slice.value > 0)
        .map((slice) => (
          <View key={slice.key} style={{ flex: slice.value, backgroundColor: slice.color }} />
        ))}
    </View>
  );
}

function CostBars({ costs }: { costs: CompanyPanelCostsFile }) {
  const max = Math.max(...costs.perPerson.map((point) => point.total), 1);
  const names = [
    ...new Set(costs.perPerson.flatMap((point) => point.parts.map((part) => part.name))),
  ];
  const color = (name: string) => PART_COLORS[names.indexOf(name) % PART_COLORS.length];
  return (
    <View className="mt-2">
      <View className="h-32 flex-row items-end gap-2">
        {costs.perPerson.map((point) => (
          <View key={point.date} className="h-full min-w-0 flex-1 justify-end">
            <Text className="mb-0.5 text-center text-2xs text-foreground">
              {money(point.total, costs.currency)}
            </Text>
            <View
              className="gap-px overflow-hidden rounded-t-sm"
              style={{ height: `${Math.max((point.total / max) * 72, 4)}%` }}
            >
              {[...point.parts].reverse().map((part) => (
                <View
                  key={part.name}
                  style={{ flex: part.amount, backgroundColor: color(part.name) }}
                />
              ))}
            </View>
            <Text className="mt-1 text-center text-2xs text-foreground-muted" numberOfLines={1}>
              {companyPanelShortDate(point.date)}
            </Text>
          </View>
        ))}
      </View>
      <View className="mt-2 flex-row flex-wrap gap-x-3 gap-y-1">
        {names.map((name) => (
          <View key={name} className="flex-row items-center gap-1">
            <View className="h-2 w-2 rounded-xs" style={{ backgroundColor: color(name) }} />
            <Text className="text-2xs text-foreground-muted">{name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function CostSummary({ costs }: { costs: CompanyPanelCostsFile }) {
  const trend = costTrend(costs.perPerson);
  if (trend === null) return <NoData what="coste por persona" />;
  const percent = trend.sinceStartPercent;
  return (
    <>
      <Big>{money(trend.latest.total, costs.currency)}</Big>
      {percent === null ? null : (
        <Sub>
          <Text style={{ color: percent <= 0 ? GREEN : RED }} className="text-xs">
            {percent > 0 ? "+" : "−"}
            {Math.abs(Math.round(percent))} %
          </Text>{" "}
          desde el {companyPanelShortDate(costs.perPerson[0]?.date ?? "")}
        </Sub>
      )}
      {trend.sinceLast ? (
        <Sub>
          {trend.sinceLast.amount === 0
            ? `Igual que el ${companyPanelShortDate(trend.sinceLast.date)}`
            : `${trend.sinceLast.amount < 0 ? "Bajó" : "Subió"} ${money(Math.abs(trend.sinceLast.amount), costs.currency)} desde el ${companyPanelShortDate(trend.sinceLast.date)}`}
        </Sub>
      ) : null}
    </>
  );
}

function CostParts({ costs }: { costs: CompanyPanelCostsFile }) {
  const latest = costs.perPerson.at(-1);
  if (!latest) return <NoData />;
  return (
    <View className="gap-1">
      {latest.parts.map((part) => (
        <View key={part.name} className="flex-row justify-between">
          <Text className="text-xs text-foreground">{part.name}</Text>
          <Text className="text-xs text-foreground">{money(part.amount, costs.currency)}</Text>
        </View>
      ))}
    </View>
  );
}

function Stepper(props: {
  readonly label: string;
  readonly value: string;
  readonly onMinus: () => void;
  readonly onPlus: () => void;
}) {
  const button = (text: string, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      className="h-9 w-9 items-center justify-center rounded-full bg-subtle"
    >
      <Text className="text-base text-foreground">{text}</Text>
    </Pressable>
  );
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className="text-xs text-foreground-muted">
        {props.label}: <Text className="text-xs font-t3-medium text-foreground">{props.value}</Text>
      </Text>
      <View className="flex-row gap-2">
        {button("−", props.onMinus)}
        {button("+", props.onPlus)}
      </View>
    </View>
  );
}

function Simulator({ costs }: { costs: CompanyPanelCostsFile }) {
  const [people, setPeople] = useState(10);
  const [volume, setVolume] = useState(costs.simulator?.baseVolume ?? 2.5);
  const [imageFifths, setImageFifths] = useState(1);
  if (!costs.simulator) return <NoData what="simulador" />;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return (
    <View className="mt-1">
      <Stepper
        label="Personas"
        value={String(people)}
        onMinus={() => setPeople((value) => clamp(value - 1, 1, 100))}
        onPlus={() => setPeople((value) => clamp(value + 1, 1, 100))}
      />
      <Stepper
        label="Volumen de Pablo"
        value={`×${String(volume).replace(".", ",")}`}
        onMinus={() => setVolume((value) => clamp(value - 0.5, 1, 4))}
        onPlus={() => setVolume((value) => clamp(value + 0.5, 1, 4))}
      />
      <Stepper
        label="Imágenes de ese día"
        value={imageFifths === 5 ? "todas" : `${imageFifths}/5`}
        onMinus={() => setImageFifths((value) => clamp(value - 1, 1, 5))}
        onPlus={() => setImageFifths((value) => clamp(value + 1, 1, 5))}
      />
      <View className="mt-2 flex-row items-baseline justify-between gap-3 border-t border-separator pt-3">
        <Sub>
          {money(
            simulateMonthlyCost(costs.simulator, { people, volume, imageFifths }) / people,
            costs.currency,
          )}{" "}
          por persona
        </Sub>
        <Text className="font-t3-medium text-2xl text-foreground">
          {money(
            simulateMonthlyCost(costs.simulator, { people, volume, imageFifths }),
            costs.currency,
          )}{" "}
          <Text className="text-xs text-foreground-muted">al mes</Text>
        </Text>
      </View>
    </View>
  );
}

function ErrorHeat({ health }: { health: CompanyPanelHealthFile }) {
  const fetchedAt = use(FetchedAtContext);
  if (!health.errorsByDay) return <NoData what="errores por día" />;
  const { days } = companyErrorDays(health.errorsByDay, fetchedAt);
  return (
    <View className="flex-row gap-0.5">
      {days.map((day) => (
        <View
          key={day.date}
          className="aspect-square flex-1 rounded-xs"
          style={{
            backgroundColor: day.count === 0 ? "#8883" : day.count > 5 ? RED : AMBER,
          }}
        />
      ))}
    </View>
  );
}

function ErrorDays({ health }: { health: CompanyPanelHealthFile }) {
  const days = (health.errorsByDay ?? []).filter((day) => day.count > 0);
  if (days.length === 0) return <Sub>Sin errores apuntados.</Sub>;
  return (
    <View className="gap-1">
      {[...days].reverse().map((day) => (
        <Text key={day.date} className="text-xs text-foreground">
          {day.date} · {day.count}
          {day.detail ? ` · ${day.detail}` : ""}
        </Text>
      ))}
    </View>
  );
}

function VersionsAndHealth({ health }: { health: CompanyPanelHealthFile }) {
  return (
    <View className="mt-2 gap-2">
      {health.versions.map((version) => (
        <View key={version.environment}>
          <View className="flex-row items-baseline justify-between">
            <Text className="text-xs font-t3-medium text-foreground">{version.environment}</Text>
            <Text className="text-base text-foreground">{version.version}</Text>
          </View>
        </View>
      ))}
      <View className="flex-row flex-wrap gap-1.5">
        {health.systems.map((system) => (
          <View
            key={system.name}
            className="flex-row items-center gap-1.5 rounded-lg bg-subtle px-2 py-1.5"
          >
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: STATUS_COLOR[system.status] }}
            />
            <Text className="text-xs text-foreground">{system.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function SystemDetails({ health }: { health: CompanyPanelHealthFile }) {
  return (
    <View className="gap-1">
      {health.versions.map((version) =>
        version.detail ? (
          <Text key={version.environment} className="text-xs text-foreground">
            {version.environment}: {version.detail}
          </Text>
        ) : null,
      )}
      {health.systems.map((system) => (
        <Text key={system.name} className="text-xs text-foreground">
          {system.name}: {system.detail ?? system.status}
        </Text>
      ))}
    </View>
  );
}

const KIND_TONE = Object.fromEntries(
  COMPANY_PANEL_JOB_KINDS.map((entry) => [entry.kind, entry.tone]),
) as Record<CompanyPanelJobKind, CompanyPanelTone>;

function TallyBar({ tally }: { tally: CompanyPanelJobTally }) {
  return (
    <SliceBar
      slices={[...COMPANY_PANEL_JOB_KINDS].reverse().map((entry) => ({
        key: entry.kind,
        value: tally[entry.kind],
        color: TONE_COLOR[entry.tone],
      }))}
    />
  );
}

function JobRow({ job }: { job: NonNullable<CompanyPanelTestsFile["jobs"]>[number] }) {
  const [open, setOpen] = useState(false);
  const kind = companyPanelJobKind(job);
  const state = companyPanelJobState(job);
  const entry = COMPANY_PANEL_JOB_KINDS.find((candidate) => candidate.kind === kind);
  return (
    <Pressable onPress={() => setOpen((current) => !current)} className="flex-row gap-2 py-1.5">
      <View className="w-1 rounded-full" style={{ backgroundColor: TONE_COLOR[KIND_TONE[kind]] }} />
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground" {...(open ? {} : { numberOfLines: 2 })}>
          {job.message}
        </Text>
        <Text className="text-2xs text-foreground-muted">{entry?.label}</Text>
        {open ? (
          <>
            {job.before ? <Sub>Antes: {job.before}</Sub> : null}
            {state.note ? <Sub>Ahora: {state.note}</Sub> : null}
            {job.why ? <Sub>Por qué: {job.why}</Sub> : null}
            {job.version ? <Sub>Versión {job.version}</Sub> : null}
          </>
        ) : null}
      </View>
    </Pressable>
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
    <View className="gap-1.5">
      {companyPanelSuites(jobs).map((entry) => (
        <Pressable
          key={entry.name}
          onPress={() => setSuite((current) => (current === entry.name ? null : entry.name))}
          className={`gap-1 rounded-lg p-1.5 ${suite === entry.name ? "bg-subtle" : ""}`}
        >
          <View className="flex-row justify-between gap-2">
            <Text className="shrink text-xs text-foreground" numberOfLines={1}>
              {entry.name}
            </Text>
            <Sub>
              {entry.tally.done}/{entry.total}
            </Sub>
          </View>
          <TallyBar tally={entry.tally} />
        </Pressable>
      ))}
      <View className="my-1 flex-row flex-wrap gap-1">
        {COMPANY_PANEL_JOB_KINDS.filter((entry) => tally[entry.kind] > 0).map((entry) => (
          <Pressable
            key={entry.kind}
            onPress={() => setKind((current) => (current === entry.kind ? null : entry.kind))}
            className={`flex-row items-center gap-1.5 rounded-full px-2 py-1 ${kind === entry.kind ? "bg-foreground" : "bg-subtle"}`}
          >
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: TONE_COLOR[entry.tone] }}
            />
            <Text
              className={`text-2xs ${kind === entry.kind ? "text-background" : "text-foreground-muted"}`}
            >
              {entry.label} · {tally[entry.kind]}
            </Text>
          </Pressable>
        ))}
      </View>
      {shown.map((job) => (
        <JobRow key={`${job.suite ?? ""}:${job.message}`} job={job} />
      ))}
    </View>
  );
}

/** The battery at a glance: how much of it is done, as a bar. */
const TestsLine = ({ tests }: { tests: CompanyPanelTestsFile }) => (
  <>
    <Text className="mt-1 text-2xl text-foreground">
      {tests.passed}{" "}
      <Text className="text-sm text-foreground-muted">
        de {tests.passed + tests.failed + tests.skipped} bien
      </Text>
    </Text>
    <View className="my-1.5">
      <SliceBar
        slices={[
          { key: "ok", value: tests.passed, color: GREEN },
          { key: "ko", value: tests.failed, color: RED },
          { key: "no", value: tests.skipped, color: TONE_COLOR.neutral },
        ]}
      />
    </View>
    <Sub>{companyPanelShortLabel(tests.label)}</Sub>
  </>
);

const Missing = ({ children }: { children: ReactNode }) => (
  <Text className="mt-1 text-xs italic" style={{ color: AMBER }}>
    {children}
  </Text>
);

function CardButton(props: {
  readonly label: string;
  readonly color?: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      onPress={props.onPress}
      className="flex-1 items-center rounded-xl border border-transparent bg-subtle p-3"
      style={[
        props.color ? { borderColor: props.color } : null,
        props.disabled ? { opacity: 0.5 } : null,
      ]}
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function MatrixRow(props: {
  readonly row: CompanyDecisionMatrixRow;
  readonly columns: ReturnType<typeof companyDecisionMatrix>["columns"];
  /** Threads speak for themselves; only what others do needs a source. */
  readonly needsSource: boolean;
}) {
  const { row, columns } = props;
  const { source } = row;
  const [open, setOpen] = useState(false);
  return (
    <View className="border-t border-separator">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        className="min-h-9 flex-row items-center gap-1"
      >
        <Text
          className="text-xs font-t3-medium text-foreground"
          style={{ flex: 1.6 }}
          numberOfLines={2}
        >
          {row.name}
        </Text>
        {columns.map((column) => (
          <View key={column.id} className="flex-1 items-center">
            {row.optionId === column.id ? (
              <View
                accessibilityLabel={`Elige ${column.label}`}
                className="h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: column.recommended ? GREEN : AMBER }}
              />
            ) : null}
          </View>
        ))}
      </Pressable>
      {open ? (
        <View className="pb-2">
          <Text className="text-xs text-foreground">{row.reason}</Text>
          {source === null ? (
            props.needsSource ? (
              <Missing>Sin fuente</Missing>
            ) : null
          ) : /^https?:\/\//.test(source) ? (
            <Pressable onPress={() => void tryOpenExternalUrl(source, "markdown-link")}>
              <Text className="mt-1 text-xs underline text-foreground-muted">Fuente</Text>
            </Pressable>
          ) : (
            <Sub>{source}</Sub>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** Who picks what. Pressing a row shows its reason and source, which live nowhere else. */
function DecisionMatrix({ decision }: { decision: CompanyPanelDecision }) {
  const { columns, threads, others } = companyDecisionMatrix(decision);
  const group = (
    title: string,
    rows: ReadonlyArray<CompanyDecisionMatrixRow>,
    needsSource: boolean,
    missing: string,
  ) => (
    <>
      <View className="mt-2.5 mb-1">
        <Label>{title}</Label>
      </View>
      {rows.length > 0 ? (
        rows.map((row) => (
          <MatrixRow key={row.key} row={row} columns={columns} needsSource={needsSource} />
        ))
      ) : (
        <Missing>{missing}</Missing>
      )}
    </>
  );
  return (
    <View className="mt-2 rounded-xl bg-subtle p-3">
      <Sub>Pulsa una fila para ver el motivo y la fuente</Sub>
      {columns.length > 0 ? (
        <View className="mt-2 flex-row items-end gap-1">
          <View style={{ flex: 1.6 }} />
          {columns.map((column) => (
            <Text
              key={column.id}
              className="flex-1 text-center text-xs font-t3-medium text-foreground"
            >
              {column.label}
            </Text>
          ))}
        </View>
      ) : null}
      {group("Hilos", threads, false, "Falta: ningún hilo ha dado su opinión.")}
      {group("Otros", others, true, "Falta: nadie ha mirado cómo lo hacen otros.")}
      {columns.length > 0 ? (
        <View className="min-h-9 flex-row items-center gap-1 border-t-2 border-separator">
          <Text className="text-xs font-t3-medium text-foreground" style={{ flex: 1.6 }}>
            Total
          </Text>
          {columns.map((column) => (
            <Text
              key={column.id}
              className="flex-1 text-center text-xs font-t3-medium text-foreground"
            >
              {column.total}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The seal says the outcome; pressing it opens who picks what. */
function ConsensusSeal({ decision }: { decision: CompanyPanelDecision }) {
  const [open, setOpen] = useState(false);
  const consensus = companyDecisionConsensus(decision);
  const text = companyDecisionSealText(decision);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        className="mt-2.5 flex-row items-center gap-2 rounded-lg px-2.5 py-2"
        style={{ backgroundColor: `${GREEN}26` }}
      >
        {consensus ? (
          <View className="flex-row gap-1">
            {Array.from({ length: consensus.total }, (_, index) => (
              <View
                key={index}
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: index < consensus.count ? GREEN : "#8886" }}
              />
            ))}
          </View>
        ) : null}
        <Text className="min-w-0 flex-1 text-xs font-t3-medium text-foreground">
          {text ?? "Faltan las opiniones de los hilos"}
        </Text>
        <Sub>{open ? "Cerrar" : "Ver quién"}</Sub>
      </Pressable>
      {open ? <DecisionMatrix decision={decision} /> : null}
    </>
  );
}

function SupportDots(props: {
  readonly title: string;
  readonly on: number;
  readonly total: number;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Sub>{props.title}</Sub>
      {props.total === 0 ? (
        <Text className="text-xs italic text-foreground-muted">sin dato</Text>
      ) : (
        <View accessibilityLabel={`${props.on} de ${props.total}`} className="flex-row gap-0.75">
          {Array.from({ length: props.total }, (_, index) => (
            <View
              key={index}
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: index < props.on ? GREEN : "#8884" }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** One decision, in the order Roi approved; a swipe does what companyDecisionSwipeAction says. */
function DecisionCard(props: {
  readonly decision: CompanyPanelDecision;
  readonly position: number;
  readonly total: number;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onMove: (step: number) => void;
}) {
  const { decision, onAnswer } = props;
  const [explained, setExplained] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const options = decision.options ?? [];
  const fetchedAt = use(FetchedAtContext);
  const [position] = useState(() => new Animated.ValueXY());
  const latest = useRef({ onAnswer, decision });
  useEffect(() => {
    latest.current = { onAnswer, decision };
  });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 12 || gesture.dy < -12,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, gesture) => {
          position.setValue({ x: gesture.dx, y: Math.min(gesture.dy, 0) });
        },
        onPanResponderRelease: (_, gesture) => {
          Animated.spring(position, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
          }).start();
          const swipe =
            gesture.dx > 90 ? "right" : gesture.dx < -90 ? "left" : gesture.dy < -70 ? "up" : null;
          if (swipe === null) return;
          const action = companyDecisionSwipeAction(latest.current.decision, swipe);
          if (action === "write") setWriting(true);
          else if (action !== null) latest.current.onAnswer(latest.current.decision.id, action);
        },
      }),
    [position],
  );

  return (
    <Animated.View
      {...pan.panHandlers}
      style={{ transform: position.getTranslateTransform() }}
      className="rounded-2xl bg-grouped-card"
    >
      <View className="p-4">
        <View className="flex-row items-center justify-between gap-2">
          <View className="min-w-0 flex-1">
            <Sub>
              Decisión {props.position} de {props.total}
              {decision.area ? ` · ${decision.area}` : ""} ·{" "}
              {companyDecisionTime(decision.createdAt, fetchedAt || Date.parse(decision.createdAt))}
            </Sub>
          </View>
          {props.total > 1 ? (
            <View className="flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decisión anterior"
                accessibilityState={{ disabled: props.position <= 1 }}
                disabled={props.position <= 1}
                hitSlop={4}
                onPress={() => props.onMove(-1)}
                className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
                style={props.position <= 1 ? { opacity: 0.4 } : null}
              >
                <Text className="text-base text-foreground">←</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decisión siguiente"
                accessibilityState={{ disabled: props.position >= props.total }}
                disabled={props.position >= props.total}
                hitSlop={4}
                onPress={() => props.onMove(1)}
                className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
                style={props.position >= props.total ? { opacity: 0.4 } : null}
              >
                <Text className="text-base text-foreground">→</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Text className="mt-1 font-t3-medium text-xl text-foreground">{decision.title}</Text>
        <Text className="mt-1.5 text-sm text-foreground">{decision.summary}</Text>
        <ConsensusSeal decision={decision} />

        <View className="mt-3 mb-1.5">
          <Label>Elige</Label>
        </View>
        <View className="gap-1.5">
          {options.length > 0 ? (
            options.map((option) => (
              <Pressable
                key={option.id}
                disabled={props.busy}
                onPress={() => onAnswer(decision.id, { type: "option", optionId: option.id })}
                className="rounded-xl bg-subtle p-3"
                style={[
                  {
                    borderColor: option.recommended ? GREEN : "transparent",
                    borderWidth: option.recommended ? 2 : 1,
                  },
                  props.busy ? { opacity: 0.5 } : null,
                ]}
              >
                <View className="min-w-0">
                  <Text className="font-t3-medium text-base text-foreground">
                    {option.label}
                    {option.recommended ? (
                      <Text className="text-xs" style={{ color: GREEN }}>
                        {"  "}Recomendada
                      </Text>
                    ) : null}
                  </Text>
                  {option.effect ? (
                    <Text className="mt-1 text-sm text-foreground">{option.effect}</Text>
                  ) : null}
                  <View className="mt-2 flex-row flex-wrap gap-x-3.5 gap-y-1">
                    <SupportDots
                      title="Tu equipo"
                      {...companyOptionSupport(decision, option.id).team}
                    />
                    <SupportDots
                      title="Otros productos"
                      {...companyOptionSupport(decision, option.id).others}
                    />
                  </View>
                </View>
              </Pressable>
            ))
          ) : (
            <View className="flex-row gap-2">
              <CardButton
                label="← No"
                color={RED}
                disabled={props.busy}
                onPress={() => onAnswer(decision.id, { type: "no" })}
              />
              <CardButton
                label="Sí →"
                color={GREEN}
                disabled={props.busy}
                onPress={() => onAnswer(decision.id, { type: "yes" })}
              />
            </View>
          )}
          <View className="flex-row gap-2">
            <CardButton
              label={explained ? "Ocultar" : "No lo entiendo"}
              onPress={() => setExplained((current) => !current)}
            />
            <CardButton
              label="Quiero otra cosa"
              onPress={() => setWriting((current) => !current)}
            />
          </View>
        </View>

        {explained ? (
          <View className="mt-2 gap-1.5 rounded-xl bg-subtle p-3">
            {decision.problem ? (
              <Text className="text-sm text-foreground">{decision.problem}</Text>
            ) : (
              <Missing>Falta la explicación fácil.</Missing>
            )}
            {decision.example ? (
              <Text className="text-sm text-foreground">Ejemplo: {decision.example}</Text>
            ) : (
              <Missing>Falta el ejemplo.</Missing>
            )}
          </View>
        ) : null}

        {writing ? (
          <View className="mt-2 gap-2">
            <TextInput
              autoFocus
              multiline
              value={text}
              onChangeText={setText}
              placeholder="Escribe lo que quieres…"
              className="min-h-20 rounded-xl bg-subtle p-3 text-sm text-foreground"
            />
            <CardButton
              label="Enviar"
              color={GREEN}
              disabled={props.busy || text.trim() === ""}
              onPress={() => onAnswer(decision.id, { type: "other", text: text.trim() })}
            />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

/** Which decision is on screen; keeps it there when others arrive or go. */
function useDecisionCursor(decisions: ReadonlyArray<CompanyPanelDecision>) {
  const [stored, setStored] = useState<CompanyDecisionCursor>({ id: null, index: 0 });
  const cursor = companyDecisionCursor(decisions, stored);
  if (cursor.id !== stored.id || cursor.index !== stored.index) setStored(cursor);
  return {
    index: cursor.index,
    decision: decisions[cursor.index],
    go: (step: number) => {
      const target = decisions[cursor.index + step];
      if (target) setStored({ id: target.id, index: cursor.index + step });
    },
  };
}

function PendingDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly cursor: ReturnType<typeof useDecisionCursor>;
}) {
  const section = props.snapshot.decisions;
  if (section.status !== "ok") {
    return <NoData broken={section.status === "invalid"} what="decisiones" />;
  }
  const { decision, index, go } = props.cursor;
  if (decision === undefined) {
    return (
      <View className="rounded-2xl bg-grouped-card p-4">
        <Text className="text-sm text-foreground">
          <Text style={{ color: GREEN }}>✓</Text> Nada que decidir ahora.
        </Text>
        <Sub>Las nuevas aparecen aquí solas.</Sub>
      </View>
    );
  }
  return (
    <DecisionCard
      key={decision.id}
      decision={decision}
      position={index + 1}
      total={section.data.decisions.length}
      busy={props.busy}
      onAnswer={props.onAnswer}
      onMove={go}
    />
  );
}

const PURPLE = COMPANY_PANEL_COLORS.decision;
const LOG_TONE_COLOR: Record<CompanyPanelLogTone, string> = {
  good: GREEN,
  warning: AMBER,
  bad: RED,
  neutral: "#888",
};
const TEST_STATE_COLOR: Record<CompanyTestState, string> = {
  passed: GREEN,
  failed: RED,
  warning: AMBER,
  pending: "#888",
  skipped: "#888",
  untested: "#8886",
};
const STATUS_WORD: Record<CompanyPanelSystemStatus, string> = {
  ok: "bien",
  warning: "con aviso",
  down: "caída",
};

const Dot = ({ color, size = 8 }: { color: string; size?: number }) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
);

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <View className="mt-4 mb-1.5">
    <Label>{children}</Label>
  </View>
);

/** A block of the home. With `detail`, pressing it opens that detail in place. */
function Block(props: {
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  readonly openHint?: string;
  readonly detail?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = props.detail !== undefined;
  const toggle = () => setOpen((current) => !current);
  return (
    <Pressable
      accessible={false}
      disabled={!expandable}
      onPress={toggle}
      className="rounded-2xl bg-grouped-card p-4"
    >
      <View className="mb-3 flex-row flex-wrap items-center justify-between gap-2">
        <Text className="font-t3-medium text-sm text-foreground">{props.title}</Text>
        <View className="flex-row items-center gap-2">
          {props.aside}
          {expandable ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={toggle}>
              <Sub>{open ? "Cerrar" : (props.openHint ?? "Pulsa")}</Sub>
            </Pressable>
          ) : null}
        </View>
      </View>
      {props.children}
      {open ? (
        <Pressable
          accessible={false}
          onPress={() => undefined}
          className="mt-4 border-t border-separator pt-1"
        >
          {props.detail}
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** Lines over a shared x axis; a shorter series just stops early, like today against yesterday. */
function LineChart(props: {
  readonly series: ReadonlyArray<{
    readonly key: string;
    readonly values: ReadonlyArray<number>;
    readonly color: string;
  }>;
  readonly height: number;
  readonly first: string;
  readonly last: string;
}) {
  const count = Math.max(...props.series.map((line) => line.values.length));
  if (count < 2) return null;
  const width = 460;
  const baseline = props.height - 2;
  const max = Math.max(...props.series.flatMap((line) => line.values), 1);
  const x = (index: number) => (index * width) / (count - 1);
  const y = (value: number) => baseline - (value / max) * (baseline - 6);
  return (
    <View className="mt-2.5">
      <Svg
        width="100%"
        height={props.height}
        viewBox={`0 0 ${width} ${props.height}`}
        preserveAspectRatio="none"
      >
        <Line x1={0} x2={width} y1={baseline} y2={baseline} stroke="#8884" />
        {props.series.map((line) => (
          <Polyline
            key={line.key}
            points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </Svg>
      <View className="mt-1 flex-row justify-between">
        <Text className="text-2xs text-foreground-muted">{props.first}</Text>
        <Text className="text-2xs text-foreground-muted">{props.last}</Text>
      </View>
    </View>
  );
}

function CacheRing({ percent }: { percent: number }) {
  const circumference = 2 * Math.PI * 32;
  return (
    <View className="mt-3 flex-row items-center gap-3 border-t border-separator pt-3">
      <Svg width={64} height={64} viewBox="0 0 80 80">
        <Circle cx={40} cy={40} r={32} fill="none" stroke="#8883" strokeWidth={8} />
        <Circle
          cx={40}
          cy={40}
          r={32}
          fill="none"
          stroke={GREEN}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
          transform="rotate(-90 40 40)"
        />
        <SvgText x={40} y={46} textAnchor="middle" fill={GREEN} fontSize={19} fontWeight="700">
          {Math.round(percent)}%
        </SvgText>
      </Svg>
      <View className="min-w-0 flex-1">
        <Text className="font-t3-medium text-xs text-foreground">Caché</Text>
        <Sub>Lo que no pagamos entero</Sub>
      </View>
    </View>
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
  const euros = (value: number) => money(value, costs.currency);
  const moved =
    latest.total === first.total
      ? `igual desde el ${companyPanelShortDate(first.date)}`
      : `${latest.total < first.total ? "bajó" : "subió"} desde ${euros(first.total)}`;
  const partColor = (index: number) =>
    COMPANY_PANEL_COLORS.parts[index % COMPANY_PANEL_COLORS.parts.length];
  const chart = (height: number) => (
    <LineChart
      series={[
        {
          key: "total",
          values: costs.perPerson.map((point) => point.total),
          color: COMPANY_PANEL_COLORS.parts[0],
        },
      ]}
      height={height}
      first={companyPanelShortDate(first.date)}
      last={companyPanelShortDate(latest.date)}
    />
  );
  return (
    <Block
      title={title}
      detail={
        <>
          <SectionTitle>Por qué bajó</SectionTitle>
          {chart(130)}
          {costs.drops?.length ? (
            <View className="mt-2">
              {costs.drops.map((drop) => (
                <View
                  key={drop.reason}
                  className="flex-row items-baseline gap-2 border-t border-separator py-1.5"
                >
                  <Text className="w-14 text-xs text-foreground">
                    {drop.amount > 0 ? "+" : "−"}
                    {euros(Math.abs(drop.amount))}
                  </Text>
                  <Dot color={drop.amount > 0 ? RED : GREEN} />
                  <Text className="min-w-0 flex-1 text-xs text-foreground">{drop.reason}</Text>
                </View>
              ))}
            </View>
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
      <Text className="text-4xl font-t3-medium text-foreground">
        {euros(latest.total)}{" "}
        <Text className="text-xs text-foreground-muted">al mes · {moved}</Text>
      </Text>
      {chart(72)}
      <View className="mt-3 h-3 flex-row gap-0.5">
        {latest.parts.map((part, index) => (
          <View
            key={part.name}
            className="rounded-xs"
            style={{ flex: part.amount, backgroundColor: partColor(index) }}
          />
        ))}
      </View>
      <View className="mt-2 flex-row flex-wrap gap-x-3 gap-y-1">
        {latest.parts.map((part, index) => (
          <View key={part.name} className="flex-row items-center gap-1">
            <View className="h-2 w-2 rounded-xs" style={{ backgroundColor: partColor(index) }} />
            <Text className="text-2xs text-foreground-muted">
              {part.name} {euros(part.amount)}
            </Text>
          </View>
        ))}
      </View>
      {costs.cache ? <CacheRing percent={costs.cache.percent} /> : <NoData what="caché" />}
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
    <View
      className="mt-2 rounded-2xl bg-subtle p-4"
      style={{ borderTopWidth: 5, borderTopColor: color }}
    >
      <Text className="font-t3-medium text-2xl text-foreground">{plan.name}</Text>
      {plan.steps.length === 0 ? (
        <NoData what="camino" />
      ) : (
        <View className="mt-5 mb-2 flex-row">
          {plan.steps.map((step, index) => {
            const reached = step.status !== "todo";
            return (
              <View key={`${step.label}:${index}`} className="min-w-0 flex-1 items-center">
                {index > 0 ? (
                  <View
                    className="absolute h-1"
                    style={{
                      top: 14,
                      left: "-50%",
                      width: "100%",
                      backgroundColor: reached ? color : "#8883",
                    }}
                  />
                ) : null}
                <View
                  className="mb-1 h-8 w-8 items-center justify-center rounded-full"
                  style={[
                    { backgroundColor: reached ? color : "#555b" },
                    step.status === "doing" ? { borderWidth: 3, borderColor: `${color}66` } : null,
                  ]}
                >
                  <Text className="text-sm font-t3-medium text-white">
                    {step.status === "done" ? "✓" : index + 1}
                  </Text>
                </View>
                <Text
                  className={`text-center text-2xs ${reached ? "text-foreground" : "text-foreground-muted"} ${step.status === "doing" ? "font-t3-medium" : ""}`}
                >
                  {step.label}
                </Text>
                {step.who ? (
                  <Text className="text-center text-2xs text-foreground-muted">{step.who}</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      {squares.length === 0 ? (
        <NoData what="cuadrados" />
      ) : (
        <View className="mt-4 flex-row flex-wrap gap-2.5">
          {squares.map((square, index) => {
            const look = COMPANY_PLAN_SQUARES[square.status];
            return (
              <Pressable
                key={`${square.text}:${index}`}
                accessibilityRole="button"
                accessibilityLabel={`${look.label}: ${square.text}`}
                accessibilityState={{ expanded: pressed === index }}
                onPress={() => setPressed((current) => (current === index ? null : index))}
                className="min-h-21 rounded-xl p-3"
                style={{
                  flexBasis: "47%",
                  flexGrow: 1,
                  backgroundColor: look.color,
                  opacity: pressed !== null && pressed !== index ? 0.75 : 1,
                }}
              >
                <View className="h-6 justify-center">
                  <Text className="text-xl font-t3-medium text-white">{look.icon}</Text>
                </View>
                <Text className="mt-1 text-sm font-t3-medium text-white">{square.text}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {open ? (
        <View className="mt-2.5 rounded-xl bg-grouped-card p-3">
          {open.why ? (
            <Text className="text-sm text-foreground">{open.why}</Text>
          ) : (
            <Text className="text-sm italic text-foreground-muted">Sin dato</Text>
          )}
        </View>
      ) : null}
      {turn ? (
        <View
          className="mt-3 rounded-xl p-3"
          style={{ backgroundColor: COMPANY_PLAN_SQUARES.decide.color }}
        >
          <Text className="text-center text-sm font-t3-medium text-white">{turn}</Text>
        </View>
      ) : null}
    </View>
  );
}

function PlansBlock({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const [selected, setSelected] = useState<string | null>(null);
  const section = snapshot.plans ?? { status: "missing" as const };
  const plans = companyPanelPlans(snapshot);
  return (
    <Block
      title={
        <>
          Planes
          <Stale kind="plans" section={section} />
        </>
      }
    >
      {plans.length === 0 ? (
        <NoData broken={section.status === "invalid"} what="planes" />
      ) : (
        <View className="gap-3">
          {plans.map((plan) => {
            const color = companyPlanColor(plan.color);
            const open = selected === plan.id;
            return (
              <View key={plan.id}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => setSelected((current) => (current === plan.id ? null : plan.id))}
                  className="rounded-xl bg-subtle p-3.5"
                  style={{ borderTopWidth: 4, borderTopColor: color }}
                >
                  <View className="flex-row items-baseline justify-between gap-2">
                    <Text className="shrink font-t3-medium text-sm text-foreground">
                      {plan.name}
                    </Text>
                    {plan.summary ? <Sub>{plan.summary}</Sub> : null}
                  </View>
                  {plan.steps.length === 0 ? (
                    <NoData what="pasos" />
                  ) : (
                    <View className="mt-2.5 flex-row gap-1">
                      {plan.steps.map((step, index) => (
                        <View key={`${step.label}:${index}`} className="min-w-0 grow shrink">
                          <View
                            className="mb-1 h-2 rounded-full"
                            style={{
                              backgroundColor:
                                step.status === "done"
                                  ? color
                                  : step.status === "doing"
                                    ? `${color}99`
                                    : "#8883",
                            }}
                          />
                          <Text
                            className={`text-2xs text-foreground ${step.status === "doing" ? "font-t3-medium" : ""}`}
                          >
                            {step.label}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </Pressable>
                {open ? <PlanDetail plan={plan} person={snapshot.person} /> : null}
              </View>
            );
          })}
        </View>
      )}
    </Block>
  );
}

function ThreadStage({ title, text, color }: { title: string; text?: string; color?: string }) {
  return (
    <View
      className="rounded-lg border border-separator p-2.5"
      style={color ? { borderColor: color } : null}
    >
      <Text className="mb-0.5 text-2xs font-t3-medium text-foreground-muted">{title}</Text>
      {text ? (
        <Text className="text-xs text-foreground">{text}</Text>
      ) : (
        <Text className="text-xs italic text-foreground-muted">Sin dato</Text>
      )}
    </View>
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
    <View
      className="mt-3 rounded-xl bg-subtle p-4"
      style={{ borderLeftWidth: 4, borderLeftColor: plan.color }}
    >
      <Sub>
        {thread.name} · {plan.name} · {props.state}
        {thread.updatedAt ? ` · ${companyPanelAgo(thread.updatedAt, fetchedAt)}` : ""}
      </Sub>
      <Text className="mt-1 mb-3 font-t3-medium text-lg text-foreground">
        {thread.now ?? thread.phrase ?? props.state}
      </Text>
      <View className="gap-2">
        <ThreadStage title="✓ ACABA DE HACER" {...(thread.done ? { text: thread.done } : {})} />
        <ThreadStage
          title={"▶\uFE0E AHORA"}
          color={plan.color}
          {...(thread.now ? { text: thread.now } : {})}
        />
        <ThreadStage title="DESPUÉS" {...(thread.next ? { text: thread.next } : {})} />
      </View>
      {thread.needsYou ? (
        <View
          className="mt-2.5 rounded-lg p-2.5"
          style={{ backgroundColor: `${COMPANY_PANEL_COLORS.decision}29` }}
        >
          <Text className="text-xs font-t3-medium text-foreground">
            Necesita de ti: {thread.needsYou}
          </Text>
        </View>
      ) : null}
      {thread.waitingFor ? (
        <View className="mt-2.5 rounded-lg bg-grouped-card p-2.5">
          <Text className="text-xs font-t3-medium text-foreground">
            Espera a: {thread.waitingFor}
          </Text>
        </View>
      ) : null}
    </View>
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
    <Block title="Hilos">
      <View className="mb-3 flex-row flex-wrap gap-x-3 gap-y-1">
        <Text className="text-2xs text-foreground-muted">Color grande: su plan · Franja:</Text>
        {Object.values(COMPANY_THREAD_TONES).map((tone) => (
          <View key={tone.label} className="flex-row items-center gap-1">
            <View className="h-2 w-2 rounded-xs" style={{ backgroundColor: tone.color }} />
            <Text className="text-2xs text-foreground-muted">
              {tone.icon} {tone.label}
            </Text>
          </View>
        ))}
      </View>
      {tiles.length === 0 ? (
        <NoData what="hilos" />
      ) : (
        <View className="flex-row flex-wrap gap-2.5">
          {tiles.map(({ thread, tile, plan }) => (
            <Pressable
              key={thread.name}
              accessibilityRole="button"
              accessibilityLabel={`${thread.name}, ${plan.name}, ${tile.state}`}
              accessibilityState={{ expanded: selected === thread.name }}
              onPress={() =>
                setSelected((current) => (current === thread.name ? null : thread.name))
              }
              className="min-h-23 flex-row overflow-hidden rounded-xl"
              style={{
                flexBasis: "47%",
                flexGrow: 1,
                opacity: selected !== null && selected !== thread.name ? 0.75 : 1,
              }}
            >
              <View className="min-w-0 p-3" style={{ flex: 4, backgroundColor: plan.color }}>
                <Text className="font-t3-medium text-sm text-white">{thread.name}</Text>
                <Text className="mt-1 text-xs text-white">
                  {thread.phrase ?? tile.state}
                  {thread.phrase && thread.updatedAt
                    ? ` · ${companyPanelAgo(thread.updatedAt, fetchedAt)}`
                    : ""}
                </Text>
                {tile.caveat && thread.phrase ? (
                  <Text className="mt-1 text-2xs text-white">{tile.caveat}</Text>
                ) : null}
              </View>
              <View
                className="items-center justify-center"
                style={{ flex: 1, backgroundColor: COMPANY_THREAD_TONES[tile.tone].color }}
              >
                <Text className="font-t3-medium text-base text-white">
                  {COMPANY_THREAD_TONES[tile.tone].icon}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
      {open ? <ThreadDetail thread={open.thread} state={open.tile.state} plan={open.plan} /> : null}
    </Block>
  );
}

const Figure = ({ value, children }: { value: string | null; children: ReactNode }) => (
  <View className="py-1">
    {value === null ? (
      <Text className="text-sm italic text-foreground-muted">Sin dato</Text>
    ) : (
      <Text className="font-t3-medium text-xl text-foreground">{value}</Text>
    )}
    <Sub>{children}</Sub>
  </View>
);

const gigabytes = (value: number | undefined) =>
  value === undefined ? null : `${Math.round(value)} GB`;

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
  const hours = Math.max(today?.length ?? 0, yesterday?.length ?? 0);
  return (
    <Block
      title={
        <>
          {status && !old ? <Text style={{ color: STATUS_COLOR[status] }}>● </Text> : null}
          Base de datos{status && !old ? `: ${STATUS_WORD[status]}` : ""}
        </>
      }
      aside={
        checkedAt === undefined ? (
          <Stale kind="health" section={section} />
        ) : (
          <Text className="text-xs text-foreground-muted" style={old ? { color: AMBER } : null}>
            {old ? "viejo · " : ""}
            {companyPanelAgo(checkedAt, fetchedAt)}
          </Text>
        )
      }
      detail={
        <>
          <SectionTitle>Lo que ha pasado</SectionTitle>
          {log?.length ? (
            log.map((entry) => (
              <View
                key={`${entry.at}:${entry.text}`}
                className="flex-row items-baseline gap-2 border-t border-separator py-1.5"
              >
                <Text className="w-20 text-xs text-foreground-muted">
                  {companyDecisionTime(entry.at, fetchedAt)}
                </Text>
                <Dot color={LOG_TONE_COLOR[entry.tone]} />
                <Text className="min-w-0 flex-1 text-xs text-foreground">{entry.text}</Text>
              </View>
            ))
          ) : (
            <NoData what="registro" />
          )}
        </>
      }
    >
      <Figure
        value={database.callsPerMinute === undefined ? null : String(database.callsPerMinute)}
      >
        llamadas por minuto
      </Figure>
      <Figure value={gigabytes(database.readGbToday)}>
        leídos hoy · ayer {gigabytes(database.readGbYesterday) ?? "sin dato"}
      </Figure>
      <Figure value={view ? `${view.percentOfWarning} %` : null}>
        de nuestro aviso
        {database.targetGbPerDay ? ` (${grouped(String(database.targetGbPerDay))} GB/día)` : ""}
        {"\n"}Conexiones{" "}
        {database.connectionsUsed === undefined || database.connectionsLimit === undefined
          ? "sin dato"
          : `${database.connectionsUsed} de ${database.connectionsLimit}`}
      </Figure>
      {today || yesterday ? (
        <>
          <LineChart
            series={[
              { key: "ayer", values: yesterday ?? [], color: "#888" },
              { key: "hoy", values: today ?? [], color: COMPANY_PANEL_COLORS.parts[0] },
            ]}
            height={90}
            first="0:00"
            last={`${hours - 1}:00`}
          />
          <View className="mt-1.5 flex-row gap-3">
            <View className="flex-row items-center gap-1">
              <Dot color={COMPANY_PANEL_COLORS.parts[0]} />
              <Text className="text-2xs text-foreground-muted">Hoy</Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Dot color="#888" />
              <Text className="text-2xs text-foreground-muted">Ayer</Text>
            </View>
          </View>
        </>
      ) : (
        <NoData what="gráfica de hoy contra ayer" />
      )}
    </Block>
  );
}

function TestTallyBar({ tally, height }: { tally: CompanyTestTally; height: number }) {
  const slices = [
    { key: "ok", value: tally.passed, color: GREEN },
    { key: "ko", value: tally.failed, color: RED },
    { key: "warn", value: tally.warning, color: AMBER },
    { key: "no", value: tally.untested, color: "#8884" },
  ];
  return (
    <View className="flex-row gap-0.5" style={{ height }}>
      {slices
        .filter((slice) => slice.value > 0)
        .map((slice) => (
          <View
            key={slice.key}
            className="rounded-xs"
            style={{ flex: slice.value, backgroundColor: slice.color }}
          />
        ))}
    </View>
  );
}

function TestTallyWords(props: { tally: CompanyTestTally; missing: (count: number) => string }) {
  const { tally, missing } = props;
  return (
    <View className="flex-row flex-wrap gap-x-2">
      {tally.passed > 0 ? (
        <Text className="text-xs font-t3-medium" style={{ color: GREEN }}>
          {tally.passed} bien
        </Text>
      ) : null}
      {tally.failed > 0 ? (
        <Text className="text-xs font-t3-medium" style={{ color: RED }}>
          {tally.failed} {tally.failed === 1 ? "falla" : "fallan"}
        </Text>
      ) : null}
      {tally.warning > 0 ? (
        <Text className="text-xs font-t3-medium" style={{ color: AMBER }}>
          {tally.warning} con aviso
        </Text>
      ) : null}
      {tally.untested > 0 ? (
        <Text className="text-xs font-t3-medium text-foreground-muted">
          {tally.untested} {missing(tally.untested)}
        </Text>
      ) : null}
    </View>
  );
}

function TestRowView({ row }: { row: CompanyTestRow }) {
  return (
    <View
      className="flex-row items-baseline gap-2 border-t border-separator py-1.5"
      style={row.state === "untested" ? { opacity: 0.6 } : null}
    >
      <Dot color={TEST_STATE_COLOR[row.state]} />
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground">{row.message}</Text>
        <Sub>
          {row.suite} · {companyTestStateLabel(row)}
          {row.why ? ` · ${row.why}` : ""}
        </Sub>
      </View>
      <View className="flex-row items-center gap-1">
        {row.history.slice(-8).map((result, index) => (
          <Dot key={index} color={TEST_STATE_COLOR[result]} />
        ))}
      </View>
    </View>
  );
}

function TestPlanRow(props: { readonly group: ReturnType<typeof companyTestsByPlan>[number] }) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  return (
    <View className="border-t border-separator">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        disabled={group.rows.length === 0}
        onPress={() => setOpen((current) => !current)}
        className="flex-row gap-2 py-2"
      >
        <View className="w-1.5 rounded-xs" style={{ backgroundColor: group.color }} />
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row flex-wrap items-baseline justify-between gap-2">
            <Text className="text-xs font-t3-medium text-foreground">{group.name}</Text>
            {group.rows.length > 0 ? (
              <TestTallyWords
                tally={group.tally}
                missing={(count) => (count === 1 ? "falta" : "faltan")}
              />
            ) : null}
          </View>
          {group.rows.length > 0 ? (
            <TestTallyBar tally={group.tally} height={10} />
          ) : (
            <Text className="text-xs italic text-foreground-muted">
              Sin dato · sin pruebas de este plan
            </Text>
          )}
        </View>
      </Pressable>
      {open ? group.rows.map((row) => <TestRowView key={row.id} row={row} />) : null}
    </View>
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
    >
      {byVersion ? (
        <>
          <Text className="font-t3-medium text-lg text-foreground">{heading?.title}</Text>
          {heading?.app ? <Sub>{heading.app}</Sub> : null}
          <TestTallyWords tally={byVersion.tally} missing={() => "sin probar"} />
          <View className="mt-2.5 mb-3.5">
            <TestTallyBar tally={byVersion.tally} height={22} />
          </View>
          <View className="mb-1">
            <Sub>Pulsa un plan para ver sus pruebas</Sub>
          </View>
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
      <View className="mt-3.5 border-t-2 border-separator pt-3.5">
        {health && errors?.latest ? (
          <View className="flex-row items-center gap-4">
            <View>
              <Text className="font-t3-medium text-2xl text-foreground">{errors.latest.count}</Text>
              <Sub>
                {errors.latestIsToday
                  ? "errores hoy"
                  : `errores el ${companyPanelShortDate(errors.latest.date)}`}
              </Sub>
            </View>
            <View className="min-w-0 flex-1">
              <ErrorHeat health={health} />
              <View className="mt-1.5">
                <Sub>
                  Últimos 15 días, el último a la derecha ·{" "}
                  {companyErrorsByPlanText(errors.latest, plans) ?? "por plan: sin dato"}
                </Sub>
              </View>
            </View>
          </View>
        ) : (
          <NoData what="errores" />
        )}
      </View>
    </Block>
  );
}

function SystemStrip({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const section = snapshot.health;
  const strip = section.status === "ok" ? section.data.strip : undefined;
  return (
    <View className="flex-row flex-wrap items-center gap-3 rounded-2xl bg-grouped-card px-4 py-2.5">
      <Text className="font-t3-medium text-xs text-foreground">
        Sistema
        <Stale kind="health" section={section} />
      </Text>
      {strip?.length ? (
        strip.map((item) => (
          <View key={item.text} className="flex-row items-center gap-1.5">
            <Dot color={STATUS_COLOR[item.status]} size={10} />
            <Text className="text-xs text-foreground">{item.text}</Text>
          </View>
        ))
      ) : (
        <Text className="text-xs italic text-foreground-muted">Sin dato</Text>
      )}
    </View>
  );
}

function DecisionsBlock(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { snapshot } = props;
  const [wantsOpen, setWantsOpen] = useState(false);
  const pending = pendingCompanyDecisions(snapshot);
  const cursor = useDecisionCursor(pending);
  const first = cursor.decision;
  // Answering the last one leaves nothing to show large, so it closes on its own.
  const open = wantsOpen && first !== undefined;
  const toggle = () => setWantsOpen((current) => !current);
  return (
    <Pressable
      accessible={false}
      disabled={first === undefined || open}
      onPress={toggle}
      className="rounded-2xl border-2 bg-grouped-card p-4"
      style={{ borderColor: PURPLE }}
    >
      <View className="mb-3 flex-row items-center justify-between gap-2">
        <Text className="font-t3-medium text-sm text-foreground">
          Decisiones
          <Stale kind="decisions" section={snapshot.decisions} />
        </Text>
        {first === undefined ? null : (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={toggle}>
            <Sub>{open ? "Cerrar" : "Pulsa"}</Sub>
          </Pressable>
        )}
      </View>
      {snapshot.decisions.status === "ok" ? (
        <Text className="text-4xl font-t3-medium" style={{ color: PURPLE }}>
          {pending.length}{" "}
          <Text className="text-xs text-foreground-muted">
            {pending.length === 1 ? "pendiente" : "pendientes"}
          </Text>
        </Text>
      ) : null}
      {open || first === undefined ? (
        <View className="mt-3">
          <PendingDecision
            snapshot={snapshot}
            busy={props.busy}
            onAnswer={props.onAnswer}
            cursor={cursor}
          />
        </View>
      ) : (
        <>
          <Text className="mt-3 font-t3-medium text-sm text-foreground">{first.title}</Text>
          <View className="mt-1.5">
            <Sub>
              {first
                ? (companyDecisionSealText(first) ?? "Faltan las opiniones de los hilos")
                : null}
            </Sub>
          </View>
        </>
      )}
    </Pressable>
  );
}

function HomeTab(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { snapshot } = props;
  const costs = snapshot.costs.status === "ok" ? snapshot.costs.data : null;
  return (
    <View className="gap-4">
      <DecisionsBlock snapshot={snapshot} busy={props.busy} onAnswer={props.onAnswer} />
      <CostBlock snapshot={snapshot} />
      <Block title="Simulador de coste">{costs ? <Simulator costs={costs} /> : <NoData />}</Block>
      <PlansBlock snapshot={snapshot} />
      <ThreadsBlock snapshot={snapshot} />
      <DatabaseBlock snapshot={snapshot} />
      <TestsAndErrorsBlock snapshot={snapshot} />
      <SystemStrip snapshot={snapshot} />
    </View>
  );
}

function DecisionsTab(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { snapshot } = props;
  const cursor = useDecisionCursor(pendingCompanyDecisions(snapshot));
  return (
    <View className="gap-3">
      <PendingDecision
        snapshot={snapshot}
        busy={props.busy}
        onAnswer={props.onAnswer}
        cursor={cursor}
      />
      {snapshot.answered.length > 0 ? <Label>Ya contestadas</Label> : null}
      {[...snapshot.answered].reverse().map((answered) => (
        <Text key={answered.decisionId} className="text-xs text-foreground">
          {answered.title ?? answered.decisionId} · {answered.answer} · {answered.person}
        </Text>
      ))}
    </View>
  );
}

function CostsTab({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  if (snapshot.costs.status !== "ok") {
    return <NoData broken={snapshot.costs.status === "invalid"} what="costes" />;
  }
  const costs = snapshot.costs.data;
  const max = Math.max(...(costs.spendLast30Days ?? []).map((day) => day.amount), 1);
  return (
    <View className="gap-2">
      <Tile>
        <Label>
          Coste por persona · regla D205 · {costs.daysPerMonth} días
          <Stale kind="costs" section={snapshot.costs} />
        </Label>
        <CostSummary costs={costs} />
        <CostBars costs={costs} />
      </Tile>
      <Tile>
        <Label>De qué está hecho</Label>
        <View className="mt-2">
          <CostParts costs={costs} />
        </View>
      </Tile>
      <Tile>
        <Label>¿Y si…? · simulador de coste</Label>
        <Simulator costs={costs} />
      </Tile>
      <Tile>
        <Label>Gasto real, últimos 30 días</Label>
        <Sub>Es lo que se ha gastado de verdad. No es el coste por persona.</Sub>
        {costs.spendLast30Days ? (
          <View className="mt-2 h-24 flex-row items-end gap-0.5">
            {costs.spendLast30Days.map((day) => (
              <View
                key={day.date}
                className="flex-1 rounded-t-xs"
                style={{
                  height: `${Math.max((day.amount / max) * 100, 2)}%`,
                  backgroundColor: BLUE,
                }}
              />
            ))}
          </View>
        ) : (
          <NoData what="gasto de 30 días" />
        )}
      </Tile>
    </View>
  );
}

function HealthTab({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  return (
    <View className="gap-2">
      <Tile detail={health ? <SystemDetails health={health} /> : undefined}>
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
      <Tile detail={health ? <ErrorDays health={health} /> : undefined}>
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
            <View className="mt-2">
              <JobsLog tests={tests} />
            </View>
          </>
        ) : (
          <NoData broken={snapshot.tests.status === "invalid"} />
        )}
      </Tile>
    </View>
  );
}

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: "home", label: "Inicio" },
  { id: "decisions", label: "Decisiones" },
  { id: "costs", label: "Costes" },
  { id: "health", label: "Salud" },
];

function EnvironmentPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(companyPanelEnvironment.snapshot({ environmentId, input: {} }));
  const answerCommand = useAtomCommand(companyPanelEnvironment.answer, "Contestar la decisión");
  const [tab, setTab] = useState<Tab>("home");
  const [busy, setBusy] = useState(false);
  const { refresh } = query;

  useEffect(() => {
    const interval = setInterval(refresh, COMPANY_PANEL_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const snapshot = query.data;
  const [fetchedAt, setFetchedAt] = useState(0);
  useEffect(() => setFetchedAt(Date.now()), [snapshot]);
  const onAnswer: AnswerFn = (decisionId, answer) => {
    setBusy(true);
    void answerCommand({ environmentId, input: { decisionId, answer } }).finally(() => {
      setBusy(false);
      refresh();
    });
  };

  return (
    <FetchedAtContext value={fetchedAt}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3 grow-0">
        <View className="flex-row gap-1.5">
          {TABS.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => setTab(item.id)}
              className={`rounded-full px-3 py-1.5 ${tab === item.id ? "bg-foreground" : "bg-subtle"}`}
            >
              <Text
                className={`text-sm ${tab === item.id ? "text-background" : "text-foreground-muted"}`}
              >
                {item.label}
                {item.id === "decisions" && snapshot
                  ? ` ${pendingCompanyDecisions(snapshot).length || ""}`
                  : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      {snapshot === null ? (
        <NoData {...(query.error ? { what: query.error } : {})} />
      ) : !snapshot.available ? (
        <NoData what="este panel no está disponible para ti" />
      ) : tab === "home" ? (
        <HomeTab snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
      ) : tab === "decisions" ? (
        <DecisionsTab snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
      ) : tab === "costs" ? (
        <CostsTab snapshot={snapshot} />
      ) : (
        <HealthTab snapshot={snapshot} />
      )}
    </FetchedAtContext>
  );
}

export function CompanyPanelRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? connections[0]?.environmentId ?? null;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="p-4 pb-16"
      keyboardShouldPersistTaps="handled"
    >
      {connections.length > 1 ? (
        <View className="mb-3 flex-row flex-wrap gap-1.5">
          {connections.map((connection) => (
            <Pressable
              key={connection.environmentId}
              onPress={() => setSelected(connection.environmentId)}
              className={`rounded-full px-3 py-1 ${connection.environmentId === environmentId ? "bg-subtle" : ""}`}
            >
              <Text className="text-xs text-foreground-muted">{connection.environmentLabel}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {environmentId === null ? (
        <NoData what="sin servidor conectado" />
      ) : (
        <EnvironmentPanel key={environmentId} environmentId={environmentId} />
      )}
    </ScrollView>
  );
}
