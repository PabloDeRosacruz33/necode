import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  buildResolveConflictsPrompt,
  describeWorktreeSetup,
} from "@t3tools/client-runtime/task-flow";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { showGitActionResult } from "../../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../../state/vcs";
import {
  askThreadAgent,
  commandFailureMessage,
  useSelectedThreadIntegrationBranch,
} from "./git-task-actions";
import { SheetListRow } from "./gitSheetComponents";

/**
 * The task actions of the web branch menu: start a task, carry this thread into a new one,
 * duplicate it, bring the integration branch in, and merge into it.
 */
export function GitTaskSection(props: {
  readonly currentBranch: string | null;
  readonly busy: boolean;
}) {
  const navigation = useNavigation();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const gitActions = useSelectedThreadGitActions();
  const integrationBranch = useSelectedThreadIntegrationBranch(selectedThreadCwd);
  const syncWith = useAtomCommand(vcsEnvironment.syncWith, { reportFailure: false });
  const mergeInto = useAtomCommand(vcsEnvironment.mergeInto, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [running, setRunning] = useState(false);

  if (!selectedThread || !selectedThreadProject || !integrationBranch) return null;
  const thread = { environmentId: selectedThread.environmentId, threadId: selectedThread.id };
  const routeParams = {
    environmentId: String(selectedThread.environmentId),
    threadId: String(selectedThread.id),
  };
  const disabled = props.busy || running || selectedThreadCwd === null;

  const offerConflictResolution = (input: {
    title: string;
    mergedRef: string;
    refName: string;
    conflictedFiles: ReadonlyArray<string>;
  }) => {
    Alert.alert(
      input.title,
      `No ha cambiado nada. Conflictos en ${input.conflictedFiles.join(", ")}.`,
      [
        { text: "Cerrar", style: "cancel" },
        {
          text: "Que lo resuelva el agente",
          onPress: () =>
            askThreadAgent(
              navigation,
              thread,
              buildResolveConflictsPrompt({ ...input, inProgress: false }),
            ),
        },
      ],
    );
  };

  const syncWithIntegrationBranch = async () => {
    if (!selectedThreadCwd) return;
    setRunning(true);
    const result = await syncWith({
      environmentId: selectedThread.environmentId,
      input: { cwd: selectedThreadCwd, baseRef: integrationBranch },
    });
    setRunning(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        Alert.alert(
          `No se pudo actualizar desde ${integrationBranch}`,
          commandFailureMessage(result),
        );
      }
      return;
    }
    const { status, refName, mergedRef, conflictedFiles, stashConflict, setup } = result.value;
    if (status === "conflicted") {
      offerConflictResolution({
        title: `${mergedRef} choca con ${refName}`,
        mergedRef,
        refName,
        conflictedFiles,
      });
      return;
    }
    const setupNotice = describeWorktreeSetup(setup);
    const description = [
      stashConflict
        ? "Tus cambios sin commit chocaban con la actualización. Git guardó una copia en el stash."
        : null,
      setupNotice?.text ?? null,
    ]
      .filter((line) => line !== null)
      .join("\n");
    showGitActionResult({
      type: setupNotice?.failed ? "error" : "success",
      title:
        status === "up_to_date"
          ? `Ya estaba al día con ${mergedRef}`
          : `${refName} incluye ya ${mergedRef}`,
      ...(description ? { description } : {}),
    });
    void gitActions.refreshSelectedThreadGitStatus({ quiet: true });
  };

  // The project's own folder: merging moves it to the integration branch for every thread there.
  const mergeSharedCheckout = (sourceRef: string) => {
    Alert.alert(
      `¿Fusionar ${sourceRef} en ${integrationBranch}?`,
      `Este hilo pasa a ${integrationBranch} y se sube si tiene remoto. Cambia la rama de esta carpeta para todos sus hilos.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Fusionar",
          onPress: async () => {
            if (!selectedThreadCwd) return;
            setRunning(true);
            const result = await mergeInto({
              environmentId: selectedThread.environmentId,
              input: { cwd: selectedThreadCwd, targetRef: integrationBranch },
            });
            setRunning(false);
            if (result._tag !== "Success") {
              if (!isAtomCommandInterrupted(result)) {
                Alert.alert(
                  `No se pudo fusionar en ${integrationBranch}`,
                  commandFailureMessage(result),
                );
              }
              return;
            }
            const { status, targetRef, pushed, conflictedFiles } = result.value;
            if (status === "conflicted") {
              offerConflictResolution({
                title: `${sourceRef} choca con ${targetRef}`,
                mergedRef: targetRef,
                refName: sourceRef,
                conflictedFiles,
              });
              return;
            }
            await updateThreadMetadata({
              environmentId: selectedThread.environmentId,
              input: { threadId: selectedThread.id, branch: targetRef, worktreePath: null },
            });
            void gitActions.refreshSelectedThreadGitStatus({ quiet: true });
            showGitActionResult({
              type: "success",
              title: `${sourceRef} fusionada en ${targetRef}`,
              description: pushed
                ? "Subida: el equipo ya puede actualizarse desde ahí."
                : "Sin subir: no tiene remoto o la subida falló.",
            });
          },
        },
      ],
    );
  };

  const mergeIntoIntegrationBranch = () => {
    const sourceRef = props.currentBranch;
    if (!sourceRef) return;
    if (selectedThreadWorktreePath === null) {
      mergeSharedCheckout(sourceRef);
      return;
    }
    navigation.navigate("GitMergeTask", {
      ...routeParams,
      cwd: selectedThreadWorktreePath,
      projectCwd: selectedThreadProject.workspaceRoot,
      branch: sourceRef,
      targetRef: integrationBranch,
    });
  };

  const rows = [
    <SheetListRow
      key="new"
      icon="folder.badge.plus"
      title="Nueva tarea"
      subtitle={`Rama y carpeta nuevas desde lo último de ${integrationBranch}`}
      disabled={props.busy}
      onPress={() =>
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(selectedThreadProject.environmentId),
            projectId: String(selectedThreadProject.id),
            taskFrom: integrationBranch,
            title: "Nueva tarea",
          },
        })
      }
    />,
    <SheetListRow
      key="continue"
      icon="arrow.right.circle"
      title="Seguir en una tarea nueva"
      subtitle="Este hilo, con su conversación, en una rama nueva"
      disabled={disabled}
      onPress={() =>
        navigation.navigate("GitContinueTask", {
          ...routeParams,
          targetRef: integrationBranch,
        })
      }
    />,
    selectedThread.latestTurn ? (
      <SheetListRow
        key="duplicate"
        icon="square.on.square"
        title="Duplicar en un hilo paralelo"
        subtitle="Una copia en su propia tarea, con este u otro agente"
        disabled={props.busy}
        onPress={() => navigation.navigate("GitDuplicateThread", routeParams)}
      />
    ) : null,
    <SheetListRow
      key="sync"
      icon="arrow.down.circle"
      title={`Actualizar desde ${integrationBranch}`}
      subtitle="Trae a esta rama lo que otros ya han fusionado"
      disabled={disabled}
      onPress={() => void syncWithIntegrationBranch()}
    />,
    props.currentBranch !== null && props.currentBranch !== integrationBranch ? (
      <SheetListRow
        key="merge"
        icon="point.topleft.down.curvedto.point.bottomright.up"
        title={`Fusionar en ${integrationBranch}`}
        subtitle={
          selectedThreadWorktreePath === null
            ? "Cambia la carpeta del proyecto a la rama de integración"
            : "Revisa, comprueba y sube sin tocar ninguna otra carpeta"
        }
        disabled={disabled}
        onPress={mergeIntoIntegrationBranch}
      />
    ) : null,
  ].filter((row) => row !== null);

  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-t3-bold text-foreground-muted">Tarea</Text>
      <View className="overflow-hidden bg-card android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border ios:px-4 ios:py-1">
        {rows.map((row, index) => (
          <View key={row.key}>
            {index > 0 && Platform.OS !== "android" ? (
              <View className="ml-12 h-px bg-border" />
            ) : null}
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}
