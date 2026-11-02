/**
 * Necode: the company panel on the phone, to see the company's state and answer its decisions
 * without asking a thread. Same data as the desktop panel; what has no data says so, never a zero.
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
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";

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

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat("es-ES", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
};

/** When the shown snapshot was fetched, to tell how old each file is. */
const FetchedAtContext = createContext(0);

function Stale(props: {
  readonly kind: CompanyPanelDataKind;
  readonly section: CompanyPanelSnapshot["health" | "costs" | "tests" | "decisions"];
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

function Gauge({ percent, color }: { percent: number; color: string }) {
  return (
    <View className="my-1.5 h-2 overflow-hidden rounded-full bg-subtle">
      <View className="h-full" style={{ width: `${percent}%`, backgroundColor: color }} />
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
      <Sub>Al mes</Sub>
      <Text className="text-2xl text-foreground">
        {money(
          simulateMonthlyCost(costs.simulator, { people, volume, imageFifths }),
          costs.currency,
        )}
      </Text>
    </View>
  );
}

function ErrorHeat({ health }: { health: CompanyPanelHealthFile }) {
  const days = health.errorsByDay;
  if (!days) return <NoData what="errores por día" />;
  const max = Math.max(...days.map((day) => day.count), 1);
  return (
    <View className="mt-2 flex-row flex-wrap gap-0.5">
      {days.map((day) => (
        <View
          key={day.date}
          className="h-4 w-4 rounded-xs"
          style={{
            backgroundColor: day.count === 0 ? GREEN : day.count / max > 0.5 ? RED : AMBER,
            opacity: day.count === 0 ? 0.35 : 0.5 + (day.count / max) * 0.5,
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

function ThreadsList({ snapshot }: { snapshot: CompanyPanelSnapshot }) {
  if (snapshot.threads.length === 0) return <NoData what="hilos" />;
  return (
    <>
      {snapshot.threads.map((thread) => {
        const view = companyThreadStatusView(thread.status);
        return (
          <View key={thread.name} className="mt-1.5 flex-row items-center gap-2">
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: TONE_COLOR[view.tone] }}
            />
            <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
              {thread.name}
            </Text>
            <Sub>{view.label}</Sub>
          </View>
        );
      })}
    </>
  );
}

function CacheView({ percent }: { percent: number }) {
  const view = companyCacheView(percent);
  return (
    <>
      <Big>{Math.round(percent)} %</Big>
      <Gauge percent={percent} color={TONE_COLOR[view.tone]} />
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
      {view ? <Gauge percent={view.percent} color={TONE_COLOR[view.tone]} /> : null}
      <Sub>{COMPANY_DATABASE_SENTENCE}</Sub>
      {view ? null : <NoData what="falta un límite para saber si es mucho" />}
    </>
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

const OPTION_COLORS = [BLUE, AMBER, "#8e4ec6", RED];

function OptionLetter({ index }: { index: number | null }) {
  if (index === null) {
    return <Text className="w-6 text-center text-xs text-foreground-muted">—</Text>;
  }
  return (
    <View
      className="h-6 w-6 items-center justify-center rounded-full"
      style={{ backgroundColor: OPTION_COLORS[index % OPTION_COLORS.length] }}
    >
      <Text className="text-xs font-t3-medium text-white">
        {companyDecisionOptionLetter(index)}
      </Text>
    </View>
  );
}

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

function ConsensusSeal({ decision }: { decision: CompanyPanelDecision }) {
  const consensus = companyDecisionConsensus(decision);
  if (consensus === null) return <Missing>Faltan las opiniones de los hilos.</Missing>;
  return (
    <View
      className="mt-2 flex-row items-center gap-2 rounded-lg px-2.5 py-1.5"
      style={{ backgroundColor: `${GREEN}26` }}
    >
      <View className="flex-row gap-1">
        {Array.from({ length: consensus.total }, (_, index) => (
          <View
            key={index}
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: index < consensus.count ? GREEN : "#8886" }}
          />
        ))}
      </View>
      <Text className="shrink text-xs text-foreground">
        {consensus.optionIndex === null
          ? `Los hilos no se ponen de acuerdo (${consensus.total})`
          : `${consensus.count} de ${consensus.total} hilos recomiendan la opción ${companyDecisionOptionLetter(consensus.optionIndex)}`}
      </Text>
    </View>
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
  const { source } = props;
  const link = source !== undefined && /^https?:\/\//.test(source);
  return (
    <View className="flex-row gap-2 py-1">
      <OptionLetter index={props.letter} />
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground">
          <Text className="text-xs font-t3-medium text-foreground">{props.name}</Text> ·{" "}
          {props.reason}
        </Text>
        {source === undefined ? (
          props.needsSource === false ? null : (
            <Missing>Sin fuente</Missing>
          )
        ) : link ? (
          <Pressable onPress={() => void tryOpenExternalUrl(source, "markdown-link")}>
            <Text className="text-xs underline text-foreground-muted">Fuente</Text>
          </Pressable>
        ) : (
          <Sub>{source}</Sub>
        )}
      </View>
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
  /** Where the card is small: pressing anywhere that is not a control opens it large. */
  readonly onOpen?: (() => void) | undefined;
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
      <Pressable accessible={false} className="p-4" disabled={!props.onOpen} onPress={props.onOpen}>
        <Sub>
          Decisión {props.position} de {props.total}
          {decision.area ? ` · ${decision.area}` : ""} ·{" "}
          {companyDecisionTime(decision.createdAt, fetchedAt || Date.parse(decision.createdAt))}
        </Sub>
        <Text className="mt-1 font-t3-medium text-xl text-foreground">{decision.title}</Text>
        <Text className="mt-1.5 text-sm text-foreground">{decision.summary}</Text>
        <ConsensusSeal decision={decision} />

        <View className="mt-3 mb-1.5">
          <Label>Elige</Label>
        </View>
        <View className="gap-1.5">
          {options.length > 0 ? (
            options.map((option, index) => (
              <Pressable
                key={option.id}
                disabled={props.busy}
                onPress={() => onAnswer(decision.id, { type: "option", optionId: option.id })}
                className="flex-row gap-2 rounded-xl border bg-subtle p-3"
                style={[
                  { borderColor: option.recommended ? GREEN : "transparent" },
                  props.busy ? { opacity: 0.5 } : null,
                ]}
              >
                <OptionLetter index={index} />
                <View className="min-w-0 flex-1">
                  <Text className="font-t3-medium text-sm text-foreground">
                    {option.label}
                    {option.recommended ? (
                      <Text className="text-xs" style={{ color: GREEN }}>
                        {"  "}Recomendada
                      </Text>
                    ) : null}
                  </Text>
                  {option.effect ? <Sub>{option.effect}</Sub> : null}
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

        <View className="mt-3">
          <Label>Qué opinan los hilos</Label>
        </View>
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

        <View className="mt-3">
          <Label>Cómo lo hacen otros</Label>
        </View>
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
      </Pressable>
    </Animated.View>
  );
}

function PendingDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onOpen?: (() => void) | undefined;
}) {
  const section = props.snapshot.decisions;
  if (section.status !== "ok") {
    return <NoData broken={section.status === "invalid"} what="decisiones" />;
  }
  const decision = section.data.decisions[0];
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
      position={1}
      total={section.data.decisions.length}
      busy={props.busy}
      onAnswer={props.onAnswer}
      onOpen={props.onOpen}
    />
  );
}

/** The decision on its own full screen, opened by pressing its card. */
function LargeDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-sheet">
        <View className="flex-row items-center justify-between p-4">
          <Text className="font-t3-medium text-base text-foreground">Decisión</Text>
          <Pressable onPress={props.onClose} className="rounded-full bg-subtle px-3 py-1.5">
            <Text className="text-sm text-foreground">Cerrar</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="px-4 pb-16" keyboardShouldPersistTaps="handled">
          <PendingDecision snapshot={props.snapshot} busy={props.busy} onAnswer={props.onAnswer} />
        </ScrollView>
      </View>
    </Modal>
  );
}

function HomeTab(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { snapshot } = props;
  const costs = snapshot.costs.status === "ok" ? snapshot.costs.data : null;
  const health = snapshot.health.status === "ok" ? snapshot.health.data : null;
  const tests = snapshot.tests.status === "ok" ? snapshot.tests.data : null;
  const [decisionOpen, setDecisionOpen] = useState(false);
  return (
    <View className="gap-2">
      {decisionOpen ? (
        <LargeDecision
          snapshot={snapshot}
          busy={props.busy}
          onAnswer={props.onAnswer}
          onClose={() => setDecisionOpen(false)}
        />
      ) : null}
      <Label>
        Decisiones · {pendingCompanyDecisions(snapshot).length}
        <Stale kind="decisions" section={snapshot.decisions} />
      </Label>
      <PendingDecision
        snapshot={snapshot}
        busy={props.busy}
        onAnswer={props.onAnswer}
        onOpen={() => setDecisionOpen(true)}
      />
      <Tile detail={costs ? <CostParts costs={costs} /> : undefined}>
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
      <Tile
        {...(costs?.cache?.detail
          ? { detail: <Sub>Detalle técnico: {costs.cache.detail}</Sub> }
          : {})}
      >
        <Label>
          Caché
          <Stale kind="costs" section={snapshot.costs} />
        </Label>
        {costs?.cache ? <CacheView percent={costs.cache.percent} /> : <NoData />}
      </Tile>
      <Tile
        {...(health?.database?.detail
          ? { detail: <Sub>Detalle técnico: {health.database.detail}</Sub> }
          : {})}
      >
        <Label>
          Base de datos
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? <DatabaseView health={health} /> : <NoData />}
      </Tile>
      <Tile>
        <Label>Hilos, ahora</Label>
        <ThreadsList snapshot={snapshot} />
      </Tile>
      <Tile detail={health ? <ErrorDays health={health} /> : undefined}>
        <Label>
          Errores, último mes
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? <ErrorHeat health={health} /> : <NoData />}
      </Tile>
      <Tile detail={tests ? <JobsLog tests={tests} /> : undefined}>
        <Label>
          Pruebas reales
          <Stale kind="tests" section={snapshot.tests} />
        </Label>
        {tests ? <TestsLine tests={tests} /> : <NoData />}
      </Tile>
      <Tile detail={health ? <SystemDetails health={health} /> : undefined}>
        <Label>
          Versiones y salud del sistema
          <Stale kind="health" section={snapshot.health} />
        </Label>
        {health ? <VersionsAndHealth health={health} /> : <NoData />}
      </Tile>
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
        <View className="gap-3">
          <PendingDecision snapshot={snapshot} busy={busy} onAnswer={onAnswer} />
          {snapshot.answered.length > 0 ? <Label>Ya contestadas</Label> : null}
          {[...snapshot.answered].reverse().map((answered) => (
            <Text key={answered.decisionId} className="text-xs text-foreground">
              {answered.title ?? answered.decisionId} · {answered.answer} · {answered.person}
            </Text>
          ))}
        </View>
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
