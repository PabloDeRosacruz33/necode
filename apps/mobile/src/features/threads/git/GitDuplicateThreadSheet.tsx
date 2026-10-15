import {
  buildThreadHandoffPrompt,
  resolveThreadHandoffTargets,
} from "@t3tools/client-runtime/thread-handoff";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useAtomCommand } from "../../../state/use-atom-command";
import { setComposerDraftText } from "../../../state/use-composer-drafts";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { showGitActionResult } from "../../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../../state/vcs";
import { commandFailureMessage } from "./git-task-actions";
import { GitTaskChoiceList, GitTaskSheetFrame } from "./GitTaskSheetFrame";
import { SheetActionButton } from "./gitSheetComponents";

/**
 * "Duplicar en un hilo paralelo" on this thread's environment: a new thread with this one's
 * history in its own task, with any agent ready there. The same agent keeps the full context;
 * another one gets a written handoff of the conversation in its composer.
 */
export function GitDuplicateThreadSheet(
  props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const navigation = useNavigation();
  const { selectedThread, selectedThreadDetailState, selectedEnvironmentRuntime } =
    useThreadSelection();
  const duplicate = useAtomCommand(vcsEnvironment.duplicateThread, { reportFailure: false });
  const providers = selectedEnvironmentRuntime?.serverConfig?.providers ?? [];
  const sourceSelection = selectedThread?.modelSelection ?? null;
  const agents = useMemo(
    () =>
      resolveThreadHandoffTargets(providers, null).map((target) =>
        // The source's own agent keeps the exact model the thread uses.
        sourceSelection && target.modelSelection.instanceId === sourceSelection.instanceId
          ? { label: target.label, modelSelection: sourceSelection }
          : target,
      ),
    [providers, sourceSelection],
  );
  const base = (selectedThread?.branch?.slice(selectedThread.branch.lastIndexOf("/") + 1) ?? "")
    .replace(/-v\d+$/, "")
    .trim();
  const [name, setName] = useState(`${base || "tarea"}-paralelo`);
  const [from, setFrom] = useState<"integration" | "current">("integration");
  const [instanceId, setInstanceId] = useState<string>(sourceSelection?.instanceId ?? "");
  const agent =
    agents.find((candidate) => candidate.modelSelection.instanceId === instanceId) ?? agents[0];
  const sameAgent = agent?.modelSelection.instanceId === sourceSelection?.instanceId;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const taskName = name.trim();
    if (!taskName || !agent || !selectedThread || running) return;
    setRunning(true);
    setError(null);
    const result = await duplicate({
      environmentId: selectedThread.environmentId,
      input: {
        source: { _tag: "local", threadId: selectedThread.id },
        taskName,
        from,
        modelSelection: agent.modelSelection,
      },
    });
    setRunning(false);
    if (result._tag === "Failure") {
      setError(commandFailureMessage(result));
      return;
    }
    const messages = Option.getOrNull(selectedThreadDetailState.data)?.messages ?? [];
    if (!result.value.forked && messages.length > 0) {
      // The agent's own memory could not come along; hand it a written summary instead.
      setComposerDraftText(
        scopedThreadKey(selectedThread.environmentId, result.value.threadId),
        buildThreadHandoffPrompt({
          title: selectedThread.title,
          sourceLabel:
            providers.find((provider) => provider.instanceId === sourceSelection?.instanceId)
              ?.displayName ??
            sourceSelection?.instanceId ??
            "",
          messages,
        }),
      );
    }
    navigation.dispatch(
      StackActions.popTo("Thread", {
        environmentId: props.route.params.environmentId,
        threadId: String(result.value.threadId),
      }),
    );
    showGitActionResult({
      type: "success",
      title: "Hilo paralelo listo",
      description: result.value.forked
        ? `Sigue en ${result.value.branch} con todo el contexto del original.`
        : `Sigue en ${result.value.branch}. Lleva el historial y un resumen en el mensaje.`,
    });
  };

  return (
    <GitTaskSheetFrame
      title="Duplicar en un hilo paralelo"
      description="Un hilo nuevo con esta conversación, en su propia tarea. Lo que hagáis en uno no toca el otro."
    >
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        value={name}
        editable={!running}
        onChangeText={setName}
        placeholder="tarea-paralelo"
        accessibilityLabel="Nombre de la tarea del hilo paralelo"
        className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
      />
      <GitTaskChoiceList
        label="Con qué agente"
        value={agent?.modelSelection.instanceId ?? ""}
        options={agents.map((candidate) => ({
          value: candidate.modelSelection.instanceId,
          label: candidate.label,
        }))}
        onChange={setInstanceId}
      />
      <GitTaskChoiceList
        label="Empezar desde"
        value={from}
        options={[
          { value: "integration", label: "Lo último de integración" },
          { value: "current", label: "Donde va este hilo" },
        ]}
        onChange={setFrom}
      />
      <Text className="px-1 text-xs text-foreground-muted">
        {sameAgent
          ? "Mismo agente: la copia sabe todo lo que sabe este hilo."
          : "Otro agente: la copia lleva el historial y un resumen en el primer mensaje."}
      </Text>
      {running ? (
        <View className="flex-row items-center gap-2 px-1">
          <ActivityIndicator size="small" />
          <Text className="text-foreground-secondary text-sm">Duplicando…</Text>
        </View>
      ) : null}
      {error ? <Text className="px-1 text-sm text-danger-foreground">{error}</Text> : null}
      <SheetActionButton
        icon="square.on.square"
        label="Duplicar"
        tone="primary"
        disabled={!name.trim() || !agent || running}
        onPress={() => void submit()}
      />
    </GitTaskSheetFrame>
  );
}
