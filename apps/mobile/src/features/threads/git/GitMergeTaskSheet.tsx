import {
  buildResolveConflictsPrompt,
  buildReviewChecklist,
  buildTaskMergeMessage,
  buildTestMissionPrompt,
  nextPermanentTaskName,
} from "@t3tools/client-runtime/task-flow";
import {
  EnvironmentId,
  ThreadId,
  type VcsMergeTaskPrepareResult,
  type VcsMergeTaskReviewResult,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { uuidv4 } from "../../../lib/uuid";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { vcsEnvironment } from "../../../state/vcs";
import { askThreadAgent, commandFailureMessage } from "./git-task-actions";
import { GitTaskSheetFrame } from "./GitTaskSheetFrame";
import { SheetActionButton } from "./gitSheetComponents";

/** A push rejected because someone merged first starts over this many times. */
const MAX_ATTEMPTS = 3;

type Step =
  | { readonly kind: "preparing" }
  | { readonly kind: "dirty"; readonly files: ReadonlyArray<string> }
  | {
      readonly kind: "conflicted";
      readonly mergedRef: string;
      readonly conflictedFiles: ReadonlyArray<string>;
    }
  | { readonly kind: "reviewing" }
  | { readonly kind: "review"; readonly headSha: string; readonly review: VcsMergeTaskReviewResult }
  | { readonly kind: "checking"; readonly runId: string; readonly headSha: string }
  | {
      readonly kind: "check-failed";
      readonly headSha: string;
      readonly log: string;
      readonly setupFailed: boolean;
    }
  | { readonly kind: "publishing" }
  | {
      readonly kind: "merged";
      readonly commit: string | null;
      readonly localTargetUpdated: boolean;
      readonly folderClosed: boolean;
    }
  | { readonly kind: "continuing"; readonly next: string }
  | { readonly kind: "continued"; readonly commit: string | null; readonly branch: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * "Fusionar en <integración>" for a task in its own worktree, the mobile side of the web
 * MergeTaskDialog: brings the integration branch in, shows what is being brought together,
 * runs the pre-merge check, then has the server build the merge commit and push it. When
 * others merged since the task started, every incoming change and every change of the task
 * must be ticked as tried by hand first.
 */
export function GitMergeTaskSheet(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly cwd: string;
    readonly projectCwd: string;
    readonly branch: string;
    readonly targetRef: string;
  }>,
) {
  const { cwd, projectCwd, branch, targetRef } = props.route.params;
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const gitActions = useSelectedThreadGitActions();
  const prepare = useAtomCommand(vcsEnvironment.mergeTaskPrepare, { reportFailure: false });
  const readReview = useAtomCommand(vcsEnvironment.mergeTaskReview, { reportFailure: false });
  const publish = useAtomCommand(vcsEnvironment.mergeTaskPublish, { reportFailure: false });
  const abort = useAtomCommand(vcsEnvironment.mergeAbort, { reportFailure: false });
  const closeTask = useAtomCommand(vcsEnvironment.closeTask, { reportFailure: false });
  const continueTask = useAtomCommand(vcsEnvironment.continueTask, { reportFailure: false });
  const [step, setStep] = useState<Step>({ kind: "preparing" });
  const [commitMessage, setCommitMessage] = useState("");
  const [forceConfirmation, setForceConfirmation] = useState("");
  const [tested, setTested] = useState<ReadonlySet<string>>(new Set());
  const attempts = useRef(0);
  // What the merge commit records; read again after every prepare.
  const reviewRef = useRef<VcsMergeTaskReviewResult | null>(null);
  const thread = { environmentId, threadId };
  const askAgent = (prompt: string) => askThreadAgent(navigation, thread, prompt);

  const runPrepare = async () => {
    attempts.current += 1;
    setStep({ kind: "preparing" });
    const result = await prepare({ environmentId, input: { cwd, targetRef } });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: commandFailureMessage(result) });
      return;
    }
    const prepared: VcsMergeTaskPrepareResult = result.value;
    if (prepared._tag === "upToDate") await finishLanded(null);
    else if (prepared._tag === "dirty") setStep({ kind: "dirty", files: prepared.files });
    else if (prepared._tag === "conflicted") {
      setStep({
        kind: "conflicted",
        mergedRef: prepared.mergedRef,
        conflictedFiles: prepared.conflictedFiles,
      });
    } else await runReview(prepared.headSha);
  };

  const runReview = async (headSha: string) => {
    setStep({ kind: "reviewing" });
    const result = await readReview({ environmentId, input: { cwd, targetRef } });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: commandFailureMessage(result) });
      return;
    }
    reviewRef.current = result.value;
    setTested(new Set());
    setStep({ kind: "review", headSha, review: result.value });
  };

  const runPublish = async (headSha: string) => {
    setStep({ kind: "publishing" });
    const message = buildTaskMergeMessage({
      branch,
      targetRef,
      threadTitle: selectedThread?.title ?? null,
      review: reviewRef.current,
    });
    const result = await publish({
      environmentId,
      input: { cwd, targetRef, headSha, message, threadId },
    });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: commandFailureMessage(result) });
      return;
    }
    if (result.value._tag === "merged") {
      await finishLanded(result.value);
      return;
    }
    // Someone merged in between: bring their work in and check again.
    if (attempts.current < MAX_ATTEMPTS) {
      await runPrepare();
      return;
    }
    setStep({
      kind: "error",
      message: `${targetRef} ha cambiado ${MAX_ATTEMPTS} veces mientras fusionabas. Vuelve a intentarlo en un momento.`,
    });
  };

  /** Closes the task, or carries a permanent thread on in its next version, as on web. */
  const finishLanded = async (
    landed: { readonly commit: string; readonly localTargetUpdated: boolean } | null,
  ) => {
    const next = nextPermanentTaskName(branch);
    if (next) {
      setStep({ kind: "continuing", next });
      const continued = await continueTask({
        environmentId,
        input: {
          threadId,
          projectCwd,
          previous: { worktreePath: cwd, branch },
          targetRef,
          taskName: next,
        },
      });
      setStep(
        continued._tag === "Success"
          ? { kind: "continued", commit: landed?.commit ?? null, branch: continued.value.branch }
          : {
              kind: "error",
              message: `${landedLabel(landed?.commit ?? null)}, pero no se pudo crear ${next}: ${commandFailureMessage(continued)}`,
            },
      );
      return;
    }
    const closed = await closeTask({
      environmentId,
      input: { projectCwd, worktreePath: cwd, branch, targetRef, deleteRemote: true },
    });
    setStep({
      kind: "merged",
      commit: landed?.commit ?? null,
      localTargetUpdated: landed?.localTargetUpdated ?? true,
      folderClosed: closed._tag === "Success" && closed.value.removedWorktree,
    });
  };

  const landedLabel = (commit: string | null) =>
    commit
      ? `Fusionada en ${targetRef} · ${commit.slice(0, 7)}`
      : `${targetRef} ya tenía esta tarea`;

  useEffect(() => {
    void runPrepare();
  }, []);

  const check = useEnvironmentQuery(
    step.kind === "checking"
      ? vcsEnvironment.mergeTaskCheck({ environmentId, input: { cwd, runId: step.runId } })
      : null,
  );
  const checkState = check.data;
  // A broken check stream must not leave the sheet waiting forever.
  useEffect(() => {
    if (step.kind !== "checking" || !check.error) return;
    setStep({ kind: "error", message: `La comprobación se ha cortado: ${check.error}` });
  }, [check.error]);
  useEffect(() => {
    if (step.kind !== "checking" || !checkState?.done) return;
    if (checkState.exitCode === 0) void runPublish(step.headSha);
    else {
      setStep({
        kind: "check-failed",
        headSha: step.headSha,
        log: checkState.output,
        setupFailed: checkState.setupFailed,
      });
    }
  }, [checkState?.done]);

  const commitAndRetry = async () => {
    const message = commitMessage.trim();
    if (!message) return;
    setStep({ kind: "preparing" });
    const result = await gitActions.onRunSelectedThreadGitAction({
      action: "commit",
      commitMessage: message,
    });
    if (result === null) {
      setStep({ kind: "error", message: "No se pudo hacer el commit." });
      return;
    }
    await runPrepare();
  };

  const backToThread = () =>
    navigation.dispatch(
      StackActions.popTo("Thread", {
        environmentId: props.route.params.environmentId,
        threadId: props.route.params.threadId,
      }),
    );

  return (
    <GitTaskSheetFrame
      title={`Fusionar en ${targetRef}`}
      description={`${branch} entra en ${targetRef} sin cambiar de rama en ninguna carpeta.`}
    >
      {step.kind === "preparing" ||
      step.kind === "publishing" ||
      step.kind === "reviewing" ||
      step.kind === "continuing" ? (
        <Progress
          text={
            step.kind === "preparing"
              ? `Trayendo lo último de ${targetRef}…`
              : step.kind === "publishing"
                ? `Subiendo a ${targetRef}…`
                : step.kind === "reviewing"
                  ? "Preparando el resumen de lo que se va a juntar…"
                  : `Fusionada. Preparando ${step.next}…`
          }
        />
      ) : null}

      {step.kind === "dirty" ? (
        <>
          <Body>
            Hay {step.files.length}{" "}
            {step.files.length === 1 ? "archivo sin commit" : "archivos sin commit"}. No se fusiona
            nada sin guardar.
          </Body>
          <FileList files={step.files} />
          <TextInput
            value={commitMessage}
            onChangeText={setCommitMessage}
            placeholder="Mensaje del commit"
            accessibilityLabel="Mensaje del commit"
            className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
          />
          <SheetActionButton
            icon="checkmark.circle"
            label="Hacer commit con este mensaje"
            disabled={!commitMessage.trim()}
            onPress={() => void commitAndRetry()}
          />
          <SheetActionButton
            icon="text.bubble"
            label="Que el agente haga commit"
            tone="primary"
            onPress={() =>
              askAgent(
                "Haz commit de todos los cambios pendientes de esta tarea con un mensaje claro. Después avísame para fusionar.",
              )
            }
          />
        </>
      ) : null}

      {step.kind === "conflicted" ? (
        <>
          <Body tone="warning">
            {step.mergedRef} choca con tu tarea. El merge queda a medias en la carpeta de esta
            tarea; la carpeta principal no se ha tocado.
          </Body>
          <FileList files={step.conflictedFiles} />
          <SheetActionButton
            icon="arrow.uturn.backward"
            label="Abortar merge"
            onPress={() => {
              void abort({ environmentId, input: { cwd } });
              navigation.goBack();
            }}
          />
          <SheetActionButton
            icon="text.bubble"
            label="Que lo resuelva el agente"
            tone="primary"
            onPress={() =>
              askAgent(
                buildResolveConflictsPrompt({
                  mergedRef: step.mergedRef,
                  refName: branch,
                  conflictedFiles: step.conflictedFiles,
                  inProgress: true,
                }),
              )
            }
          />
        </>
      ) : null}

      {step.kind === "review" ? (
        <ReviewPanel
          review={step.review}
          targetRef={targetRef}
          tested={tested}
          onToggle={(key) =>
            setTested((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onAskHowToTest={() =>
            askAgent(buildTestMissionPrompt({ branch, targetRef, review: step.review }))
          }
          onCheckAndMerge={() =>
            setStep({ kind: "checking", runId: uuidv4(), headSha: step.headSha })
          }
        />
      ) : null}

      {step.kind === "checking" || step.kind === "check-failed" ? (
        <>
          <Body tone={step.kind === "check-failed" ? "danger" : undefined}>
            {step.kind === "check-failed"
              ? step.setupFailed
                ? "No se pudieron reinstalar las dependencias de esta tarea. No se ha comprobado ni subido nada."
                : "La comprobación ha fallado."
              : checkState?.setup && !checkState.command
                ? `Las dependencias han cambiado: reinstalando (${checkState.setup.command})…`
                : checkState?.command
                  ? `Comprobando: ${checkState.command}`
                  : "Comprobando…"}
          </Body>
          <LogView text={step.kind === "check-failed" ? step.log : (checkState?.output ?? "")} />
        </>
      ) : null}

      {step.kind === "check-failed" ? (
        <>
          {step.setupFailed ? (
            <SheetActionButton
              icon="arrow.clockwise"
              label="Reintentar"
              onPress={() => void runPrepare()}
            />
          ) : (
            <>
              <Body>Para fusionar igualmente, escribe «fusionar»:</Body>
              <TextInput
                autoCapitalize="none"
                value={forceConfirmation}
                onChangeText={setForceConfirmation}
                accessibilityLabel="Confirmar fusión sin comprobación"
                className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
              />
              <SheetActionButton
                icon="exclamationmark.triangle"
                label="Fusionar igualmente"
                tone="danger"
                disabled={forceConfirmation.trim().toLowerCase() !== "fusionar"}
                onPress={() => void runPublish(step.headSha)}
              />
            </>
          )}
          <SheetActionButton
            icon="text.bubble"
            label="Pedir al agente que lo arregle"
            tone="primary"
            onPress={() =>
              askAgent(
                step.setupFailed
                  ? `Al preparar esta tarea para fusionar en ${targetRef}, la reinstalación de dependencias ha fallado. Averigua por qué, arréglalo y haz commit si hace falta. Final del log:\n\n${step.log.slice(-4000)}`
                  : `La comprobación previa a fusionar en ${targetRef} ha fallado. Arréglalo y haz commit. Final del log:\n\n${step.log.slice(-4000)}`,
              )
            }
          />
        </>
      ) : null}

      {step.kind === "merged" ? (
        <>
          <Body tone="success">
            {step.commit
              ? `${landedLabel(step.commit)}.${
                  step.localTargetUpdated
                    ? ""
                    : ` La carpeta principal no se ha tocado; actualízala desde ${targetRef} cuando quieras.`
                }`
              : `No hay nada que fusionar: ${targetRef} ya tiene todo lo de esta tarea.`}
          </Body>
          <Body>
            {step.folderClosed
              ? `Se han borrado la carpeta y la rama de la tarea. Si sigues escribiendo en este hilo, la tarea empieza de nuevo desde ${targetRef}.`
              : "La carpeta de la tarea tiene cambios sin guardar o está en uso, así que se ha quedado. Ciérrala cuando ya no la necesites."}
          </Body>
          <SheetActionButton icon="checkmark.circle" label="Listo" onPress={backToThread} />
          <SheetActionButton
            icon="arrow.right.circle"
            label="Seguir en una tarea nueva"
            tone="primary"
            onPress={() =>
              navigation.dispatch(
                StackActions.replace("GitContinueTask", {
                  environmentId: props.route.params.environmentId,
                  threadId: props.route.params.threadId,
                  targetRef,
                }),
              )
            }
          />
        </>
      ) : null}

      {step.kind === "continued" ? (
        <>
          <Body tone="success">
            {landedLabel(step.commit)}. Este hilo sigue en {step.branch}, con toda la conversación.
          </Body>
          <SheetActionButton
            icon="checkmark.circle"
            label="Seguir trabajando"
            tone="primary"
            onPress={backToThread}
          />
        </>
      ) : null}

      {step.kind === "error" ? (
        <>
          <Body tone="danger">{step.message}</Body>
          <SheetActionButton
            icon="arrow.clockwise"
            label="Reintentar"
            onPress={() => void runPrepare()}
          />
        </>
      ) : null}
    </GitTaskSheetFrame>
  );
}

function Progress(props: { readonly text: string }) {
  return (
    <View className="flex-row items-center gap-2 px-1">
      <ActivityIndicator size="small" />
      <Text className="shrink text-sm text-foreground-secondary">{props.text}</Text>
    </View>
  );
}

function Body(props: {
  readonly children: React.ReactNode;
  readonly tone?: "warning" | "danger" | "success" | undefined;
}) {
  return (
    <Text
      className={
        props.tone === "danger"
          ? "px-1 text-sm leading-normal text-danger-foreground"
          : props.tone === "warning"
            ? "px-1 text-sm leading-normal text-warning-foreground"
            : props.tone === "success"
              ? "px-1 text-sm leading-normal text-adaptive-emerald-700-300"
              : "px-1 text-sm leading-normal text-foreground"
      }
    >
      {props.children}
    </Text>
  );
}

function FileList(props: { readonly files: ReadonlyArray<string> }) {
  return (
    <View className="rounded-xl bg-card px-3 py-2">
      {props.files.map((file) => (
        <Text key={file} className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {file}
        </Text>
      ))}
    </View>
  );
}

function LogView(props: { readonly text: string }) {
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      className="max-h-72 rounded-xl bg-card px-3 py-2"
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      <Text selectable className="font-mono text-xs text-foreground-secondary">
        {props.text}
      </Text>
    </ScrollView>
  );
}

/** What is being brought together, in plain words, and the checklist when others merged first. */
function ReviewPanel(props: {
  readonly review: VcsMergeTaskReviewResult;
  readonly targetRef: string;
  readonly tested: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onAskHowToTest: () => void;
  readonly onCheckAndMerge: () => void;
}) {
  const { review, targetRef } = props;
  const othersMerged = review.incoming.length > 0;
  const checklist = buildReviewChecklist(review);
  const sharedNames = review.sharedFiles.map((file) => file.slice(file.lastIndexOf("/") + 1));
  return (
    <>
      {othersMerged ? (
        <>
          <Body tone="warning">
            Espera: mientras trabajabas, otros subieron cambios a {targetRef}. Ya están juntados con
            tu tarea en su carpeta, pero todavía no se ha subido nada.
          </Body>
          <Heading>Lo que subieron otros</Heading>
          {review.incoming.map((entry) => (
            <View key={entry.commit} className="gap-0.5 px-1">
              <Text className="text-sm text-foreground">
                <Text className="font-t3-bold">{entry.author}</Text> — {entry.title}
              </Text>
              {entry.summary.map((line) => (
                <Text key={line} className="text-xs text-foreground-muted">
                  • {line}
                </Text>
              ))}
            </View>
          ))}
          {review.incomingTruncated ? <Body>Y otros cambios anteriores.</Body> : null}
        </>
      ) : null}
      <Heading>
        {othersMerged
          ? "Lo que has hecho tú en esta tarea"
          : `Esto es lo que se sube a ${targetRef}`}
      </Heading>
      <Body>{review.own.title}</Body>
      {review.own.summary.map((line) => (
        <Text key={line} className="px-1 text-xs text-foreground-muted">
          • {line}
        </Text>
      ))}
      {othersMerged && sharedNames.length > 0 ? (
        <Body tone="warning">
          Los dos habéis tocado{" "}
          {sharedNames.length === 1 ? "un archivo" : `${sharedNames.length} archivos`} en común (
          {sharedNames.slice(0, 5).join(", ")}
          {sharedNames.length > 5 ? "…" : ""}). Prueba con cuidado esas partes.
        </Body>
      ) : null}
      {othersMerged ? (
        <>
          <Heading>Antes de subir, pruébalo tú en la app de esta tarea</Heading>
          {checklist.map((item) => {
            const checked = props.tested.has(item.key);
            return (
              <Pressable
                key={item.key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                className="flex-row items-start gap-2 rounded-xl px-1 py-1.5 active:bg-subtle"
                onPress={() => props.onToggle(item.key)}
              >
                {checked ? (
                  <SymbolView
                    name="checkmark.circle"
                    size={18}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                ) : (
                  <View className="size-[18px] rounded-full border border-border" />
                )}
                <Text className="shrink text-sm text-foreground">
                  {item.text}
                  <Text className="text-foreground-muted">
                    {item.author ? ` · de ${item.author}` : " · tuyo"}
                  </Text>
                </Text>
              </Pressable>
            );
          })}
          <SheetActionButton
            icon="text.bubble"
            label="Pedir al agente cómo probarlo"
            onPress={props.onAskHowToTest}
          />
        </>
      ) : null}
      <SheetActionButton
        icon="point.topleft.down.curvedto.point.bottomright.up"
        label="Comprobar y fusionar"
        tone="primary"
        disabled={othersMerged && checklist.some((item) => !props.tested.has(item.key))}
        onPress={props.onCheckAndMerge}
      />
    </>
  );
}

function Heading(props: { readonly children: React.ReactNode }) {
  return <Text className="px-1 pt-1 text-sm font-t3-bold text-foreground">{props.children}</Text>;
}
