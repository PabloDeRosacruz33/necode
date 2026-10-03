import { formatTaskMergeMessage, type VcsMergeTaskReviewResult } from "@t3tools/contracts";

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
