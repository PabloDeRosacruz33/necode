import { nextPermanentTaskName } from "@t3tools/client-runtime/task-flow";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useEnvironmentQuery } from "../../../state/query";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { showGitActionResult } from "../../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../../state/vcs";
import { commandFailureMessage } from "./git-task-actions";
import { GitTaskSheetFrame } from "./GitTaskSheetFrame";
import { SheetActionButton } from "./gitSheetComponents";

/**
 * "Seguir en una tarea nueva": the same thread, with its whole conversation, moves to a new
 * branch and folder from the latest integration branch. The task it leaves is closed first.
 */
export function GitContinueTaskSheet(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly targetRef: string;
  }>,
) {
  const { targetRef } = props.route.params;
  const navigation = useNavigation();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const continueTask = useAtomCommand(vcsEnvironment.continueTask, { reportFailure: false });
  const gitStatus = useEnvironmentQuery(
    selectedThread && selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const currentBranch = gitStatus.data?.refName ?? selectedThread?.branch ?? null;
  const previous =
    selectedThreadWorktreePath && currentBranch
      ? { worktreePath: selectedThreadWorktreePath, branch: currentBranch }
      : null;
  // A permanent thread suggests its next version.
  const [name, setName] = useState(() =>
    previous ? (nextPermanentTaskName(previous.branch) ?? "") : "",
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const taskName = name.trim();
    if (!taskName || running || !selectedThread || !selectedThreadProject) return;
    setRunning(true);
    setError(null);
    const result = await continueTask({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        projectCwd: selectedThreadProject.workspaceRoot,
        previous,
        targetRef,
        taskName,
      },
    });
    setRunning(false);
    if (result._tag === "Failure") {
      setError(commandFailureMessage(result));
      return;
    }
    navigation.dispatch(
      StackActions.popTo("Thread", {
        environmentId: props.route.params.environmentId,
        threadId: props.route.params.threadId,
      }),
    );
    showGitActionResult({
      type: "success",
      title: "Tarea nueva lista",
      description: `Este hilo sigue en ${result.value.branch}, con toda la conversación.`,
    });
  };

  return (
    <GitTaskSheetFrame
      title="Seguir en una tarea nueva"
      description={
        previous
          ? `Se cierra la tarea actual (${previous.branch}) y este hilo sigue en una rama nueva desde lo último de ${targetRef}. La conversación se conserva.`
          : `Este hilo sigue en una rama nueva desde lo último de ${targetRef}, con su propia carpeta. La conversación se conserva.`
      }
    >
      <TextInput
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        value={name}
        editable={!running}
        onChangeText={setName}
        onSubmitEditing={() => void start()}
        placeholder="arreglar-sidebar"
        accessibilityLabel="Nombre de la tarea nueva"
        className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
      />
      {running ? (
        <View className="flex-row items-center gap-2 px-1">
          <ActivityIndicator size="small" />
          <Text className="text-foreground-secondary text-sm">Preparando la tarea nueva…</Text>
        </View>
      ) : null}
      {error ? <Text className="px-1 text-sm text-danger-foreground">{error}</Text> : null}
      <SheetActionButton
        icon="arrow.right.circle"
        label="Seguir en la tarea nueva"
        tone="primary"
        disabled={!name.trim() || running}
        onPress={() => void start()}
      />
    </GitTaskSheetFrame>
  );
}
