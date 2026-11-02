/**
 * Necode: the company panel on the phone, to see the company's state and answer its decisions
 * without asking a thread. Same data as the desktop panel; what has no data says so, never a zero.
 */
import {
  COMPANY_PANEL_REFRESH_MS,
  costTrend,
  pendingCompanyDecisions,
  simulateMonthlyCost,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
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

function CostBars({ costs }: { costs: CompanyPanelCostsFile }) {
  const max = Math.max(...costs.perPerson.map((point) => point.total), 1);
  return (
    <View className="mt-2 h-14 flex-row items-end gap-1.5">
      {costs.perPerson.map((point, index) => (
        <View
          key={point.date}
          className="flex-1 rounded-t-sm"
          style={{
            height: `${Math.max((point.total / max) * 100, 4)}%`,
            backgroundColor: index === costs.perPerson.length - 1 ? GREEN : BLUE,
            opacity: index === costs.perPerson.length - 1 ? 1 : 0.55,
          }}
        />
      ))}
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
          desde el {costs.perPerson[0]?.date}
        </Sub>
      )}
      {trend.sinceLast ? (
        <Sub>
          {trend.sinceLast.amount === 0
            ? `Igual que el ${trend.sinceLast.date}`
            : `${trend.sinceLast.amount < 0 ? "Bajó" : "Subió"} ${money(Math.abs(trend.sinceLast.amount), costs.currency)} desde el ${trend.sinceLast.date}`}
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
          {version.detail ? <Sub>{version.detail}</Sub> : null}
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
      {health.systems.map((system) => (
        <Text key={system.name} className="text-xs text-foreground">
          {system.name}: {system.detail ?? system.status}
        </Text>
      ))}
    </View>
  );
}

function JobsLog({ tests }: { tests: CompanyPanelTestsFile }) {
  if (!tests.jobs) return <NoData what="registro de encargos" />;
  return (
    <View className="gap-1.5">
      {tests.jobs.map((job) => (
        <View key={`${job.suite ?? ""}:${job.message}`}>
          <Text className="text-xs text-foreground">
            {job.result === "passed" ? "✅" : job.result === "failed" ? "❌" : "⚪"} {job.message}
          </Text>
          {job.why ? <Sub>Por qué: {job.why}</Sub> : null}
        </View>
      ))}
    </View>
  );
}

const TestsLine = ({ tests }: { tests: CompanyPanelTestsFile }) => (
  <>
    <Text className="mt-1 text-2xl text-foreground">
      ✅ {tests.passed} · ❌ {tests.failed} · ⚪ {tests.skipped}
    </Text>
    <Sub>{tests.label}</Sub>
  </>
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
      className={`flex-1 items-center rounded-xl border p-3 ${props.color ? "" : "border-separator"}`}
      style={[
        props.color ? { borderColor: props.color } : null,
        props.disabled ? { opacity: 0.5 } : null,
      ]}
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/** One decision: swipe right for yes, left for no, up to write something else. */
function DecisionCard(props: {
  readonly decision: CompanyPanelDecision;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const { decision, onAnswer } = props;
  const [explained, setExplained] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const options = decision.options ?? [];
  const [position] = useState(() => new Animated.ValueXY());
  const latest = useRef({ onAnswer, canSwipe: options.length === 0, id: decision.id });
  useEffect(() => {
    latest.current = { onAnswer, canSwipe: options.length === 0, id: decision.id };
  });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          latest.current.canSwipe && (Math.abs(gesture.dx) > 12 || gesture.dy < -12),
        onPanResponderMove: (_, gesture) => {
          position.setValue({ x: gesture.dx, y: Math.min(gesture.dy, 0) });
        },
        onPanResponderRelease: (_, gesture) => {
          Animated.spring(position, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
          }).start();
          const { id, onAnswer: answer } = latest.current;
          if (gesture.dx > 90) answer(id, { type: "yes" });
          else if (gesture.dx < -90) answer(id, { type: "no" });
          else if (gesture.dy < -70) setWriting(true);
        },
      }),
    [position],
  );

  return (
    <Animated.View
      {...pan.panHandlers}
      style={{ transform: position.getTranslateTransform() }}
      className="rounded-2xl bg-grouped-card p-4"
    >
      <Text className="mb-1 font-t3-medium text-base text-foreground">{decision.title}</Text>
      <Text className="text-sm text-foreground">{decision.summary}</Text>

      {explained ? (
        <View className="mt-3 gap-2 border-t border-separator pt-3">
          {decision.problem ? (
            <Text className="text-sm text-foreground">{decision.problem}</Text>
          ) : null}
          {decision.example ? (
            <Text className="text-sm text-foreground">Ejemplo: {decision.example}</Text>
          ) : null}
          {decision.opinions?.map((opinion) => (
            <Text key={opinion.thread} className="text-sm text-foreground">
              {opinion.thread}: {opinion.opinion}
            </Text>
          ))}
          {decision.references?.map((reference) => (
            <Text key={reference.name} className="text-sm text-foreground">
              {reference.name}: {reference.how}
              {reference.source ? ` (${reference.source})` : ""}
            </Text>
          ))}
        </View>
      ) : null}

      {writing ? (
        <View className="mt-3 gap-2">
          <TextInput
            autoFocus
            multiline
            value={text}
            onChangeText={setText}
            placeholder="Escribe lo que quieras decidir…"
            className="min-h-20 rounded-xl bg-subtle p-3 text-sm text-foreground"
          />
          <View className="flex-row gap-2">
            <CardButton label="Volver" onPress={() => setWriting(false)} />
            <CardButton
              label="Enviar"
              color={GREEN}
              disabled={props.busy || text.trim() === ""}
              onPress={() => onAnswer(decision.id, { type: "other", text: text.trim() })}
            />
          </View>
        </View>
      ) : (
        <View className="mt-3 gap-2">
          {options.length > 0 ? (
            options.map((option) => (
              <CardButton
                key={option.id}
                label={`${option.label}${option.recommended ? " · recomendada" : ""}`}
                disabled={props.busy}
                {...(option.recommended ? { color: GREEN } : {})}
                onPress={() => onAnswer(decision.id, { type: "option", optionId: option.id })}
              />
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
            <CardButton label="↑ Otra cosa" onPress={() => setWriting(true)} />
            <CardButton
              label={explained ? "Ocultar" : "No lo entiendo"}
              onPress={() => setExplained((current) => !current)}
            />
          </View>
        </View>
      )}
    </Animated.View>
  );
}

function PendingDecision(props: {
  readonly snapshot: CompanyPanelSnapshot;
  readonly busy: boolean;
  readonly onAnswer: AnswerFn;
}) {
  const section = props.snapshot.decisions;
  if (section.status !== "ok") {
    return <NoData broken={section.status === "invalid"} what="decisiones" />;
  }
  const decision = section.data.decisions[0];
  if (decision === undefined) return <Sub>Sin decisiones pendientes.</Sub>;
  return (
    <DecisionCard
      key={decision.id}
      decision={decision}
      busy={props.busy}
      onAnswer={props.onAnswer}
    />
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
  return (
    <View className="gap-2">
      <Label>Decisiones · {pendingCompanyDecisions(snapshot).length}</Label>
      <PendingDecision snapshot={snapshot} busy={props.busy} onAnswer={props.onAnswer} />
      <Tile detail={costs ? <CostParts costs={costs} /> : undefined}>
        <Label>Coste por persona{costs ? ` · ${costs.daysPerMonth} días` : ""}</Label>
        {costs ? (
          <>
            <CostSummary costs={costs} />
            <CostBars costs={costs} />
          </>
        ) : (
          <NoData broken={snapshot.costs.status === "invalid"} />
        )}
      </Tile>
      <View className="flex-row gap-2">
        <Tile className="flex-1">
          <Label>Caché</Label>
          {costs?.cache ? <Big>{Math.round(costs.cache.percent)} %</Big> : <NoData />}
        </Tile>
        <Tile
          className="flex-1"
          {...(health?.database?.detail ? { detail: <Sub>{health.database.detail}</Sub> } : {})}
        >
          <Label>Base</Label>
          {health?.database ? <Big>{Math.round(health.database.readGbPerDay)} GB</Big> : <NoData />}
        </Tile>
      </View>
      <Tile>
        <Label>Hilos, ahora</Label>
        {snapshot.threads.length === 0 ? (
          <NoData what="hilos" />
        ) : (
          snapshot.threads.map((thread) => (
            <View key={thread.name} className="mt-1 flex-row justify-between gap-2">
              <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                {thread.name}
              </Text>
              <Sub>{thread.status}</Sub>
            </View>
          ))
        )}
      </Tile>
      <Tile detail={health ? <ErrorDays health={health} /> : undefined}>
        <Label>Errores, último mes</Label>
        {health ? <ErrorHeat health={health} /> : <NoData />}
      </Tile>
      <Tile detail={tests ? <JobsLog tests={tests} /> : undefined}>
        <Label>Pruebas reales</Label>
        {tests ? <TestsLine tests={tests} /> : <NoData />}
      </Tile>
      <Tile detail={health ? <SystemDetails health={health} /> : undefined}>
        <Label>Versiones y salud del sistema</Label>
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
        <Label>Coste por persona · regla D205 · {costs.daysPerMonth} días</Label>
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
        <Label>Versiones y salud del sistema</Label>
        {health ? (
          <VersionsAndHealth health={health} />
        ) : (
          <NoData broken={snapshot.health.status === "invalid"} />
        )}
      </Tile>
      <Tile detail={health ? <ErrorDays health={health} /> : undefined}>
        <Label>Errores, último mes</Label>
        {health ? <ErrorHeat health={health} /> : <NoData />}
      </Tile>
      <Tile>
        <Label>Pruebas reales y registro de encargos</Label>
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
  const onAnswer: AnswerFn = (decisionId, answer) => {
    setBusy(true);
    void answerCommand({ environmentId, input: { decisionId, answer } }).finally(() => {
      setBusy(false);
      refresh();
    });
  };

  return (
    <>
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
              {answered.decisionId} · {answered.answer} · {answered.person}
            </Text>
          ))}
        </View>
      ) : tab === "costs" ? (
        <CostsTab snapshot={snapshot} />
      ) : (
        <HealthTab snapshot={snapshot} />
      )}
    </>
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
