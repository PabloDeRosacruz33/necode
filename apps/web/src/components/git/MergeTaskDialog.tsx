/**
 * "Fusionar en <integración>" for a task in its own worktree: brings the integration branch into
 * the worktree, shows what is being brought together, runs the project's pre-merge check with its
 * log live, then has the server build the merge commit and push it. No folder ever checks the
 * integration branch out. When others merged since the task started, the person merging must
 * tick every incoming change and every change of the task as tried by hand before it goes on.
 */
import type {
  EnvironmentId,
  ThreadId,
  VcsMergeTaskPrepareResult,
  VcsMergeTaskReviewResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { CheckCircle2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { useClientSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { buildResolveConflictsPrompt, nextPermanentTaskName } from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  buildReviewChecklist,
  buildTaskMergeMessage,
  buildTestMissionPrompt,
  type ReviewChecklistItem,
} from "./mergeTaskReview.logic";

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
  | { readonly kind: "reviewing"; readonly headSha: string }
  | {
      readonly kind: "review";
      readonly headSha: string;
      readonly review: VcsMergeTaskReviewResult;
    }
  | { readonly kind: "checking"; readonly runId: string; readonly headSha: string }
  | {
      readonly kind: "check-failed";
      readonly headSha: string;
      readonly log: string;
      /** The task's setup script failed before the check could run. */
      readonly setupFailed: boolean;
    }
  | { readonly kind: "publishing" }
  | { readonly kind: "merged"; readonly commit: string; readonly localTargetUpdated: boolean }
  | { readonly kind: "closed" }
  | { readonly kind: "upToDate" }
  /** `commit` is null when the integration branch already had the whole task. */
  | { readonly kind: "continuing"; readonly commit: string | null; readonly next: string }
  | { readonly kind: "continued"; readonly commit: string | null; readonly branch: string }
  | { readonly kind: "error"; readonly message: string };

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message ? error.message : "Algo ha fallado.";
}

export function MergeTaskDialog({
  open,
  onOpenChange,
  environmentId,
  cwd,
  projectCwd,
  branch,
  targetRef,
  threadId,
  threadTitle,
  onAskAgent,
  onContinueTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  /** The task's worktree. */
  cwd: string;
  projectCwd: string;
  branch: string;
  targetRef: string;
  threadId: ThreadId | null;
  threadTitle: string | null;
  /** Puts a request in the thread's composer for the agent. */
  onAskAgent: (prompt: string) => void;
  /** Keeps this thread's conversation in a new task once this one is merged. */
  onContinueTask: () => void;
}) {
  const prepare = useAtomCommand(vcsEnvironment.mergeTaskPrepare, { reportFailure: false });
  const readReview = useAtomCommand(vcsEnvironment.mergeTaskReview, { reportFailure: false });
  const publish = useAtomCommand(vcsEnvironment.mergeTaskPublish, { reportFailure: false });
  const abort = useAtomCommand(vcsEnvironment.mergeAbort, { reportFailure: false });
  const closeTask = useAtomCommand(vcsEnvironment.closeTask, { reportFailure: false });
  const continueTask = useAtomCommand(vcsEnvironment.continueTask, { reportFailure: false });
  const branchPrefix = useClientSettings((settings) => settings.taskBranchPrefix);
  const commit = useGitStackedAction({ environmentId, cwd });
  const [step, setStep] = useState<Step>({ kind: "preparing" });
  const [commitMessage, setCommitMessage] = useState("");
  const [forceConfirmation, setForceConfirmation] = useState("");
  const attempts = useRef(0);
  // What the merge commit records; read again after every prepare.
  const reviewRef = useRef<VcsMergeTaskReviewResult | null>(null);
  const [tested, setTested] = useState<ReadonlySet<string>>(new Set());
  // A permanent thread moves to its next version while this dialog is still open.
  const [mergingBranch, setMergingBranch] = useState(branch);

  const runPrepare = async () => {
    attempts.current += 1;
    setStep({ kind: "preparing" });
    const result = await prepare({ environmentId, input: { cwd, targetRef } });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: failureMessage(result) });
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
    setStep({ kind: "reviewing", headSha });
    const result = await readReview({ environmentId, input: { cwd, targetRef } });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: failureMessage(result) });
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
      threadTitle,
      review: reviewRef.current,
    });
    const result = await publish({
      environmentId,
      input: { cwd, targetRef, headSha, message, ...(threadId ? { threadId } : {}) },
    });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: failureMessage(result) });
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

  /**
   * What follows once the task is in the integration branch, merged just now or already there
   * (`landed` null): the same either way, so a task pushed by hand still closes or rotates.
   */
  const finishLanded = async (
    landed: { readonly commit: string; readonly localTargetUpdated: boolean } | null,
  ) => {
    const next = nextPermanentTaskName(branch);
    if (next && threadId) {
      // A permanent thread never stops: it carries straight on in its next version.
      setStep({ kind: "continuing", commit: landed?.commit ?? null, next });
      const continued = await continueTask({
        environmentId,
        input: {
          threadId,
          projectCwd,
          previous: { worktreePath: cwd, branch },
          targetRef,
          taskName: next,
          ...(branchPrefix.trim() ? { branchPrefix: branchPrefix.trim() } : {}),
        },
      });
      setStep(
        continued._tag === "Success"
          ? { kind: "continued", commit: landed?.commit ?? null, branch: continued.value.branch }
          : {
              kind: "error",
              message: `${landedLabel(landed?.commit ?? null)}, pero no se pudo crear ${next}: ${failureMessage(continued)}`,
            },
      );
      return;
    }
    setStep(landed ? { kind: "merged", ...landed } : { kind: "upToDate" });
  };

  const landedLabel = (commit: string | null) =>
    commit
      ? `Fusionada en ${targetRef} · ${commit.slice(0, 7)}`
      : `${targetRef} ya tenía esta tarea`;

  // Starts when the dialog opens; a closed dialog keeps nothing.
  useEffect(() => {
    if (!open) return;
    attempts.current = 0;
    reviewRef.current = null;
    setMergingBranch(branch);
    setCommitMessage("");
    setForceConfirmation("");
    void runPrepare();
  }, [open]);

  const check = useEnvironmentQuery(
    open && step.kind === "checking"
      ? vcsEnvironment.mergeTaskCheck({ environmentId, input: { cwd, runId: step.runId } })
      : null,
  );
  const checkState = check.data;
  const checkLogRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    checkLogRef.current?.scrollTo({ top: checkLogRef.current.scrollHeight });
  }, [checkState?.output]);
  // A check stream that breaks (a dropped connection, a server it cannot understand) must not
  // leave the dialog waiting forever.
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

  const askAgent = (prompt: string) => {
    onAskAgent(prompt);
    onOpenChange(false);
  };

  const commitAndRetry = async () => {
    const message = commitMessage.trim();
    if (!message) return;
    setStep({ kind: "preparing" });
    const result = await commit.run({
      actionId: randomUUID(),
      action: "commit",
      commitMessage: message,
    });
    if (result._tag === "Failure") {
      setStep({ kind: "error", message: failureMessage(result) });
      return;
    }
    await runPrepare();
  };

  const finishTask = async () => {
    const result = await closeTask({
      environmentId,
      input: {
        projectCwd,
        worktreePath: cwd,
        branch,
        targetRef,
        deleteRemote: true,
        ...(threadId ? { threadId } : {}),
      },
    });
    if (result._tag === "Failure" || !result.value.removedWorktree) {
      toastManager.add({
        type: "error",
        title: "No se pudo cerrar la tarea",
        description:
          result._tag === "Failure"
            ? failureMessage(result)
            : "La carpeta de la tarea tiene cambios o está en uso.",
      });
      return;
    }
    setStep({ kind: "closed" });
    toastManager.add({
      type: "success",
      title: "Tarea cerrada",
      description: `Se borraron su carpeta y la rama ${branch}. El hilo sigue disponible en la carpeta del proyecto.`,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fusionar en {targetRef}</DialogTitle>
          <DialogDescription>
            {mergingBranch} entra en {targetRef} sin cambiar de rama en ninguna carpeta.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 text-sm">
            {step.kind === "preparing" || step.kind === "publishing" ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-4" />
                {step.kind === "preparing"
                  ? `Trayendo lo último de ${targetRef}…`
                  : `Subiendo a ${targetRef}…`}
              </p>
            ) : null}
            {step.kind === "dirty" ? (
              <>
                <p>
                  Hay {step.files.length}{" "}
                  {step.files.length === 1 ? "archivo sin commit" : "archivos sin commit"}. No se
                  fusiona nada sin guardar.
                </p>
                <ul className="max-h-28 overflow-y-auto font-mono text-xs text-muted-foreground">
                  {step.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    className="flex-1"
                    placeholder="Mensaje del commit"
                    aria-label="Mensaje del commit"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!commitMessage.trim() || commit.isPending}
                    onClick={() => void commitAndRetry()}
                  >
                    Hacer commit con este mensaje
                  </Button>
                </div>
              </>
            ) : null}
            {step.kind === "conflicted" ? (
              <>
                <p className="flex gap-2 text-warning-foreground">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  {step.mergedRef} choca con tu tarea. El merge queda a medias en la carpeta de esta
                  tarea; la carpeta principal no se ha tocado.
                </p>
                <ul className="font-mono text-xs text-muted-foreground">
                  {step.conflictedFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {step.kind === "reviewing" ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-4" />
                Preparando el resumen de lo que se va a juntar…
              </p>
            ) : null}
            {step.kind === "review" ? (
              <MergeTaskReviewPanel
                review={step.review}
                targetRef={targetRef}
                checklist={buildReviewChecklist(step.review)}
                tested={tested}
                onTestedChange={(key, checked) =>
                  setTested((current) => {
                    const next = new Set(current);
                    if (checked) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
              />
            ) : null}
            {step.kind === "checking" || step.kind === "check-failed" ? (
              <>
                <p
                  className={
                    step.kind === "check-failed" && step.setupFailed
                      ? "flex gap-2 text-destructive-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {step.kind === "check-failed"
                    ? step.setupFailed
                      ? "No se pudieron reinstalar las dependencias de esta tarea. No se ha comprobado ni subido nada."
                      : "La comprobación ha fallado."
                    : checkState?.setup && !checkState.command
                      ? `Las dependencias han cambiado: reinstalando (${checkState.setup.command})…`
                      : checkState?.command
                        ? `Comprobando: ${checkState.command}`
                        : "Comprobando…"}
                </p>
                <pre
                  ref={checkLogRef}
                  className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
                >
                  {step.kind === "check-failed" ? step.log : (checkState?.output ?? "")}
                </pre>
              </>
            ) : null}
            {step.kind === "check-failed" && !step.setupFailed ? (
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                Para fusionar igualmente, escribe «fusionar»:
                <Input
                  size="sm"
                  aria-label="Confirmar fusión sin comprobación"
                  value={forceConfirmation}
                  onChange={(event) => setForceConfirmation(event.target.value)}
                />
              </label>
            ) : null}
            {step.kind === "merged" ? (
              <p className="flex gap-2 text-success-foreground">
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
                <span>
                  Fusionada en {targetRef} · {step.commit.slice(0, 7)}.
                  {step.localTargetUpdated
                    ? ""
                    : ` La carpeta principal no se ha tocado; actualízala desde ${targetRef} cuando quieras.`}
                </span>
              </p>
            ) : null}
            {step.kind === "upToDate" ? (
              <p className="text-muted-foreground">
                No hay nada que fusionar: {targetRef} ya tiene todo lo de esta tarea. Puedes
                cerrarla o seguir en una nueva.
              </p>
            ) : null}
            {step.kind === "continuing" ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-4" />
                {landedLabel(step.commit)}. Preparando {step.next}…
              </p>
            ) : null}
            {step.kind === "continued" ? (
              <p className="flex gap-2 text-success-foreground">
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {landedLabel(step.commit)}. Este hilo sigue en {step.branch}, con toda la
                  conversación.
                </span>
              </p>
            ) : null}
            {step.kind === "error" ? (
              <p className="text-destructive-foreground">{step.message}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {step.kind === "dirty" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                askAgent(
                  "Haz commit de todos los cambios pendientes de esta tarea con un mensaje claro. Después avísame para fusionar.",
                )
              }
            >
              Que el agente haga commit
            </Button>
          ) : null}
          {step.kind === "conflicted" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void abort({ environmentId, input: { cwd } });
                  onOpenChange(false);
                }}
              >
                Abortar merge
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  askAgent(
                    buildResolveConflictsPrompt({
                      mergedRef: step.mergedRef,
                      refName: branch,
                      conflictedFiles: step.conflictedFiles,
                      inProgress: true,
                    }),
                  )
                }
              >
                Que lo resuelva el agente
              </Button>
            </>
          ) : null}
          {step.kind === "review" ? (
            <>
              {step.review.incoming.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    askAgent(buildTestMissionPrompt({ branch, targetRef, review: step.review }))
                  }
                >
                  Pedir al agente cómo probarlo
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={
                  step.review.incoming.length > 0 &&
                  buildReviewChecklist(step.review).some((item) => !tested.has(item.key))
                }
                onClick={() =>
                  setStep({ kind: "checking", runId: randomUUID(), headSha: step.headSha })
                }
              >
                Comprobar y fusionar
              </Button>
            </>
          ) : null}
          {step.kind === "check-failed" ? (
            <>
              {step.setupFailed ? (
                <Button size="sm" variant="outline" onClick={() => void runPrepare()}>
                  Reintentar
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={forceConfirmation.trim().toLowerCase() !== "fusionar"}
                  onClick={() => void runPublish(step.headSha)}
                >
                  Fusionar igualmente
                </Button>
              )}
              <Button
                size="sm"
                onClick={() =>
                  askAgent(
                    step.setupFailed
                      ? `Al preparar esta tarea para fusionar en ${targetRef}, la reinstalación de dependencias ha fallado. Averigua por qué, arréglalo y haz commit si hace falta. Final del log:\n\n${step.log.slice(-4000)}`
                      : `La comprobación previa a fusionar en ${targetRef} ha fallado. Arréglalo y haz commit. Final del log:\n\n${step.log.slice(-4000)}`,
                  )
                }
              >
                Pedir al agente que lo arregle
              </Button>
            </>
          ) : null}
          {step.kind === "error" ? (
            <Button size="sm" variant="outline" onClick={() => void runPrepare()}>
              Reintentar
            </Button>
          ) : null}
          {step.kind === "continued" ? (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Seguir trabajando
            </Button>
          ) : null}
          {step.kind === "merged" || step.kind === "upToDate" ? (
            <>
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                Dejar la tarea abierta
              </Button>
              <Button size="sm" variant="outline" onClick={() => void finishTask()}>
                Cerrar tarea
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  onContinueTask();
                }}
              >
                Seguir en una tarea nueva
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function formatMergeDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("es-ES", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** What is being brought together, in plain words, and the checklist when others merged first. */
function MergeTaskReviewPanel({
  review,
  targetRef,
  checklist,
  tested,
  onTestedChange,
}: {
  review: VcsMergeTaskReviewResult;
  targetRef: string;
  checklist: ReadonlyArray<ReviewChecklistItem>;
  tested: ReadonlySet<string>;
  onTestedChange: (key: string, checked: boolean) => void;
}) {
  const othersMerged = review.incoming.length > 0;
  const sharedNames = review.sharedFiles.map((file) => file.slice(file.lastIndexOf("/") + 1));
  return (
    <>
      {othersMerged ? (
        <>
          <p className="flex gap-2 text-warning-foreground">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              Espera: mientras trabajabas, otros subieron cambios a {targetRef}. Ya están juntados
              con tu tarea en su carpeta, pero todavía no se ha subido nada.
            </span>
          </p>
          <section className="grid gap-2">
            <h3 className="font-medium">Lo que subieron otros</h3>
            <ul className="grid gap-2">
              {review.incoming.map((entry) => (
                <li key={entry.commit}>
                  <p>
                    <span className="font-medium">{entry.author}</span>
                    <span className="text-muted-foreground"> · {formatMergeDate(entry.date)}</span>
                    {" — "}
                    {entry.title}
                  </p>
                  {entry.summary.length > 0 ? (
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {entry.summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {review.incomingTruncated ? (
              <p className="text-xs text-muted-foreground">Y otros cambios anteriores.</p>
            ) : null}
          </section>
        </>
      ) : null}
      <section className="grid gap-2">
        <h3 className="font-medium">
          {othersMerged
            ? "Lo que has hecho tú en esta tarea"
            : `Esto es lo que se sube a ${targetRef}`}
        </h3>
        <p>{review.own.title}</p>
        {review.own.summary.length > 0 ? (
          <ul className="list-disc pl-5 text-muted-foreground">
            {review.own.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {review.own.generated ? null : (
          <p className="text-xs text-muted-foreground">
            No se pudo escribir un resumen; estos son los commits de la tarea.
          </p>
        )}
      </section>
      {othersMerged && sharedNames.length > 0 ? (
        <p className="text-warning-foreground">
          Los dos habéis tocado{" "}
          {sharedNames.length === 1 ? "un archivo" : `${sharedNames.length} archivos`} en común (
          {sharedNames.slice(0, 5).join(", ")}
          {sharedNames.length > 5 ? "…" : ""}). Prueba con cuidado esas partes.
        </p>
      ) : null}
      {othersMerged ? (
        <section className="grid gap-2">
          <h3 className="font-medium">Antes de subir, pruébalo tú en la app de esta tarea</h3>
          <p className="text-xs text-muted-foreground">
            Marca cada punto cuando lo hayas probado a mano. Las comprobaciones automáticas se pasan
            después, pero no sustituyen tu prueba.
          </p>
          <ul className="grid gap-1.5">
            {checklist.map((item) => (
              <li key={item.key}>
                <label className="flex items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={tested.has(item.key)}
                    onCheckedChange={(checked) => onTestedChange(item.key, checked === true)}
                  />
                  <span>
                    {item.text}
                    {item.author ? (
                      <span className="text-muted-foreground"> · de {item.author}</span>
                    ) : (
                      <span className="text-muted-foreground"> · tuyo</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
