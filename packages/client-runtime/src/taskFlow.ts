/**
 * Task flow shared by web and mobile: the integration branch tasks start from and merge into,
 * and the texts the merge hands to the agent or records in the merge commit.
 */
import {
  formatTaskMergeMessage,
  type VcsMergeTaskReviewResult,
  type VcsRef,
  type VcsWorktreeSetupRun,
} from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef } from "@t3tools/shared/git";

/** The branch work merges into when nothing is configured and the repository has it. */
export const INTEGRATION_BRANCH_NAME = "staging";

/**
 * The branch tasks start from and merge into: the one configured (t3.json, then the project
 * setting), else `staging` when the repository has it, else its default branch.
 */
export function resolveIntegrationBranch(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isRemote" | "isDefault">>,
  configured?: string | null,
): string | null {
  if (configured?.trim()) return configured.trim();
  const hasStaging = refs.some((ref) =>
    ref.isRemote
      ? deriveLocalBranchNameFromRemoteRef(ref.name) === INTEGRATION_BRANCH_NAME
      : ref.name === INTEGRATION_BRANCH_NAME,
  );
  if (hasStaging) return INTEGRATION_BRANCH_NAME;
  const defaultRef = refs.find((ref) => ref.isDefault);
  if (!defaultRef) return null;
  return defaultRef.isRemote
    ? deriveLocalBranchNameFromRemoteRef(defaultRef.name)
    : defaultRef.name;
}

/**
 * Composer text that asks the agent to resolve a merge of the integration branch into a task.
 * `inProgress` means the merge was left open in the folder; otherwise Necode backed out of it.
 * What already landed on the integration branch is kept, and the task's goal is reapplied on
 * top of it, including where the teammate's work merged cleanly but still overlaps the task.
 */
export function buildResolveConflictsPrompt(input: {
  readonly mergedRef: string;
  readonly refName: string;
  readonly conflictedFiles: ReadonlyArray<string>;
  readonly inProgress: boolean;
}): string {
  const { mergedRef, refName } = input;
  return [
    input.inProgress
      ? `Hay un merge de ${mergedRef} a medias en esta rama (${refName}). Archivos en conflicto:`
      : `Fusiona ${mergedRef} en esta rama (${refName}). Necode lo intentó y lo deshizo por conflictos en:`,
    ...input.conflictedFiles.map((file) => `- ${file}`),
    "",
    `${mergedRef} trae trabajo de otras tareas que ya está integrado. Para resolverlo:`,
    `1. Entiende qué entró con \`git log --format='%h %an %s%n%b' ${refName}..${mergedRef}\` (los merges de tareas llevan el título del hilo que las hizo) y el objetivo de esta rama por esta conversación y \`git log ${mergedRef}..${refName}\`.`,
    `2. Conserva todo lo que ya está en ${mergedRef}: funcionalidades, props, textos y arreglos. No devuelvas un archivo a su versión antigua para que encaje con esta rama.`,
    `3. Vuelve a aplicar el objetivo de esta rama sobre el código nuevo, también donde ${mergedRef} cambió la zona que toca esta rama aunque Git no marque conflicto.`,
    "4. Si los dos lados son incompatibles y no puedes conservar ambos, para y pregúntame antes de elegir.",
    "5. Ejecuta las comprobaciones que correspondan y haz commit del merge.",
    `6. Al terminar, resume qué conservaste de ${mergedRef}, qué adaptaste de esta rama y qué revisaste sin conflicto.`,
  ].join("\n");
}

/**
 * A task named `…-v<N>` is a permanent thread (a "department": UI, performance…): merging it
 * continues the same thread in `…-v<N+1>`. Returns that next task name, or null for other tasks.
 */
export function nextPermanentTaskName(branch: string): string | null {
  const name = branch.slice(branch.lastIndexOf("/") + 1);
  const match = /^(.+)-v(\d+)$/.exec(name);
  return match ? `${match[1]}-v${Number(match[2]) + 1}` : null;
}

export interface ReviewChecklistItem {
  readonly key: string;
  readonly text: string;
  /** Who brought the change in; null for the task being merged. */
  readonly author: string | null;
}

/**
 * What the person merging must try by hand when others' work reached the integration branch
 * since the task started: every incoming change and every change of the task, one item each.
 */
export function buildReviewChecklist(
  review: VcsMergeTaskReviewResult,
): ReadonlyArray<ReviewChecklistItem> {
  const incoming = review.incoming.flatMap((entry) =>
    (entry.howToTest.length > 0 ? entry.howToTest : [`Sigue funcionando: ${entry.title}`]).map(
      (text, index) => ({ key: `${entry.commit}:${index}`, text, author: entry.author }),
    ),
  );
  const own = (
    review.own.howToTest.length > 0
      ? review.own.howToTest
      : [`Funciona lo de esta tarea: ${review.own.title}`]
  ).map((text, index) => ({ key: `own:${index}`, text, author: null }));
  return [...incoming, ...own];
}

/** The merge commit message, carrying the task's summary for whoever merges next. */
export function buildTaskMergeMessage(input: {
  readonly branch: string;
  readonly targetRef: string;
  readonly threadTitle: string | null;
  readonly review: VcsMergeTaskReviewResult | null;
}): string {
  const { review } = input;
  return formatTaskMergeMessage({
    branch: input.branch,
    targetRef: input.targetRef,
    title: input.threadTitle ?? review?.own.title ?? null,
    summary: review?.own.generated ? review.own.summary : [],
    howToTest: review?.own.generated ? review.own.howToTest : [],
    testedWith: review?.incoming.map((entry) => `${entry.author}: ${entry.title}`) ?? [],
  });
}

/**
 * Composer text for the task's agent once others' work is in the task: run the automatic
 * checks and explain, step by step and without jargon, how to try each item by hand.
 */
export function buildTestMissionPrompt(input: {
  readonly branch: string;
  readonly targetRef: string;
  readonly review: VcsMergeTaskReviewResult;
}): string {
  const { review } = input;
  const incoming = review.incoming.map((entry) =>
    [`- ${entry.author}: ${entry.title}`, ...entry.summary.map((line) => `  - ${line}`)].join("\n"),
  );
  return [
    `Esta tarea (${input.branch}) ya tiene juntado lo último de ${input.targetRef}. Antes de fusionar, tengo que probar a mano en la app de esta tarea que todo funciona junto.`,
    "",
    `Lo que subieron otros a ${input.targetRef} mientras trabajábamos:`,
    ...incoming,
    "",
    `Lo que hace esta tarea: ${review.own.title}`,
    ...review.own.summary.map((line) => `- ${line}`),
    "",
    "Lista que tengo que probar:",
    ...buildReviewChecklist(review).map(
      (item) => `- ${item.text}${item.author ? ` (de ${item.author})` : ""}`,
    ),
    "",
    "1. Ejecuta las comprobaciones automáticas que correspondan y arregla lo que falle.",
    "2. Revisa que lo nuevo de los demás y lo de esta tarea encajan, sobre todo donde tocan lo mismo, y arregla lo que no.",
    "3. Explícame en español sencillo, sin tecnicismos, cómo probar a mano cada punto de la lista: qué abro, qué hago y qué debería ver.",
    `4. No fusiones ni subas nada: lo haré yo desde «Fusionar en ${input.targetRef}» cuando lo haya probado.`,
  ].join("\n");
}
/**
 * The toast line after bringing work into a task whose lockfiles changed, so its setup script
 * ran again. Null when nothing had to be reinstalled.
 */
export function describeWorktreeSetup(
  setup: VcsWorktreeSetupRun | undefined,
): { readonly failed: boolean; readonly text: string } | null {
  if (!setup) return null;
  if (setup.exitCode === 0) {
    return {
      failed: false,
      text: `Las dependencias cambiaron y se han reinstalado con «${setup.name}».`,
    };
  }
  const tail = setup.output.trim().split("\n").slice(-3).join("\n");
  const code = setup.exitCode === null ? "" : ` (código ${setup.exitCode})`;
  return {
    failed: true,
    text: `Las dependencias cambiaron, pero «${setup.name}» ha fallado${code}: la app puede no arrancar en esta tarea.${tail ? `\n${tail}` : ""}`,
  };
}
