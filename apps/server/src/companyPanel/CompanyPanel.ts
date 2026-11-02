/**
 * Necode: reads the company panel's data files and records answers to its decisions. Everything
 * lives in the host's panel folder, each file published by whoever owns that data. A person sees
 * the panel only if `personas.json` lists their team member; a host without the folder has no
 * panel at all.
 */
import {
  CompanyPanelAnsweredDecision,
  CompanyPanelCostsFile,
  CompanyPanelDecisionsFile,
  CompanyPanelError,
  CompanyPanelHealthFile,
  CompanyPanelPlansFile,
  CompanyPanelTestsFile,
  IsoDateTime,
  type CompanyPanelAnswer,
  type CompanyPanelDecision,
  type CompanyPanelSnapshot,
  type CompanyPanelThreadActivity,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PersonasFile = Schema.Struct({ members: Schema.Record(Schema.String, Schema.String) });

/** The company's thread list: who each person's informer is, and which threads do the work. */
const ThreadsFile = Schema.Struct({
  informadores: Schema.Record(Schema.String, Schema.Struct({ threadId: Schema.String })),
  trabajo: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ threadId: Schema.String, titulo: Schema.String })),
  ),
});
type ThreadsFile = typeof ThreadsFile.Type;

/** The coordinator's hand-written line about each thread. Nothing here decides a tile's colour. */
const ThreadNotesFile = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      phrase: Schema.optional(Schema.String),
      done: Schema.optional(Schema.String),
      now: Schema.optional(Schema.String),
      next: Schema.optional(Schema.String),
      needsYou: Schema.optional(Schema.String),
      waitingFor: Schema.optional(Schema.String),
      updatedAt: Schema.optional(IsoDateTime),
    }),
  ),
});

const ANSWERS_FILE = "respuestas.jsonl";
const decodeAnswerLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CompanyPanelAnsweredDecision),
);
const encodeAnswerLine = Schema.encodeEffect(Schema.fromJsonString(CompanyPanelAnsweredDecision));

export const companyPanelDir = (input: {
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly path: Path.Path;
}) =>
  input.env.NECODE_COMPANY_PANEL_DIR ?? input.path.join(input.home, ".necora", "empresa", "panel");

const readJsonFile = <A, I>(schema: Schema.Codec<A, I>, file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(file);
    const stat = yield* fileSystem.stat(file);
    const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text);
    const modified = Option.getOrElse(stat.mtime, () => 0);
    return { data, updatedAt: DateTime.formatIso(DateTime.makeUnsafe(modified)) };
  });

const readSection = <A, I>(schema: Schema.Codec<A, I>, file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { status: "missing" as const };
    return yield* readJsonFile(schema, file).pipe(
      Effect.map(({ data, updatedAt }) => ({ status: "ok" as const, updatedAt, data })),
      Effect.orElseSucceed(() => ({ status: "invalid" as const })),
    );
  });

const readAnswers = (dir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem
      .readFileString(path.join(dir, ANSWERS_FILE))
      .pipe(Effect.orElseSucceed(() => ""));
    const answers: Array<CompanyPanelAnsweredDecision> = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const answer = yield* decodeAnswerLine(line).pipe(Effect.option);
      if (Option.isSome(answer)) answers.push(answer.value);
    }
    return answers;
  });

const personFor = (dir: string, memberId: string | null) =>
  Effect.gen(function* () {
    if (memberId === null) return null;
    const path = yield* Path.Path;
    const personas = yield* readJsonFile(PersonasFile, path.join(dir, "personas.json")).pipe(
      Effect.option,
    );
    return Option.isSome(personas) ? (personas.value.data.members[memberId] ?? null) : null;
  });

const readThreadsFile = (dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* readJsonFile(ThreadsFile, path.join(path.dirname(dir), "hilos.json")).pipe(
      Effect.map(({ data }) => data),
      Effect.option,
      Effect.map(Option.getOrNull),
    );
  });

const UNAVAILABLE: CompanyPanelSnapshot = {
  available: false,
  person: null,
  decisions: { status: "missing" },
  answered: [],
  costs: { status: "missing" },
  health: { status: "missing" },
  tests: { status: "missing" },
  threads: [],
};

export const readCompanyPanelSnapshot = (input: {
  readonly dir: string;
  readonly memberId: string | null;
  /** What a thread is doing now, from its own records; null when it cannot be read. */
  readonly threadStatus: (threadId: string) => Effect.Effect<{
    readonly status: string;
    readonly lastActivityAt: string | null;
    readonly backgroundCommands: number;
  } | null>;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const person = yield* personFor(input.dir, input.memberId);
    if (person === null) return UNAVAILABLE;
    const file = (name: string) => path.join(input.dir, name);
    const decisions = yield* readSection(CompanyPanelDecisionsFile, file("decisiones.json"));
    const answered = yield* readAnswers(input.dir);
    const answeredIds = new Set(answered.map((answer) => answer.decisionId));
    const threadsFile = yield* readThreadsFile(input.dir);
    const threads: Array<CompanyPanelThreadActivity> = [];
    const notes = yield* readJsonFile(ThreadNotesFile, file("hilos-estado.json")).pipe(
      Effect.map(({ data }) => data.threads),
      Effect.orElseSucceed(() => []),
    );
    for (const thread of Object.values(threadsFile?.trabajo ?? {})) {
      const state = yield* input.threadStatus(thread.threadId);
      if (state === null) continue;
      const { name: _name, ...note } =
        notes.find((candidate) => candidate.name === thread.titulo) ?? {};
      threads.push({
        ...note,
        name: thread.titulo,
        status: state.status,
        backgroundCommands: state.backgroundCommands,
        ...(state.lastActivityAt === null ? {} : { lastActivityAt: state.lastActivityAt }),
      });
    }
    return {
      available: true,
      person,
      decisions:
        decisions.status === "ok"
          ? {
              ...decisions,
              data: {
                decisions: decisions.data.decisions.filter(
                  (decision) => !answeredIds.has(decision.id),
                ),
              },
            }
          : decisions,
      answered,
      costs: yield* readSection(CompanyPanelCostsFile, file("costes.json")),
      health: yield* readSection(CompanyPanelHealthFile, file("salud.json")),
      tests: yield* readSection(CompanyPanelTestsFile, file("pruebas.json")),
      plans: yield* readSection(CompanyPanelPlansFile, file("planes.json")),
      threads,
    } satisfies CompanyPanelSnapshot;
  });

export function companyPanelAnswerLabel(
  decision: CompanyPanelDecision,
  answer: CompanyPanelAnswer,
): string | null {
  switch (answer.type) {
    case "yes":
      return "Sí";
    case "no":
      return "No";
    case "other":
      return answer.text;
    case "option":
      return decision.options?.find((option) => option.id === answer.optionId)?.label ?? null;
  }
}

/** The message the person's informer receives: their answer, in their words. */
export const companyPanelAnswerMessage = (decision: CompanyPanelDecision, label: string) =>
  `Decisión ${decision.id} · ${decision.title}\nMi respuesta: ${label}`;

const failure = (message: string) => new CompanyPanelError({ message });

/**
 * Prepares an answer: who answers, the informer thread it goes to, and the message. `record` then
 * stores it once it is delivered, which takes the card out of the panel for both people.
 */
export const prepareCompanyPanelAnswer = (input: {
  readonly dir: string;
  readonly memberId: string | null;
  readonly decisionId: string;
  readonly answer: CompanyPanelAnswer;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const person = yield* personFor(input.dir, input.memberId);
    if (person === null) return yield* failure("No tienes acceso a este panel.");
    const decisions = yield* readJsonFile(
      CompanyPanelDecisionsFile,
      path.join(input.dir, "decisiones.json"),
    ).pipe(Effect.mapError(() => failure("No se pueden leer las decisiones.")));
    const decision = decisions.data.decisions.find(
      (candidate) => candidate.id === input.decisionId,
    );
    if (decision === undefined) return yield* failure("Esa decisión ya no está pendiente.");
    const answers = yield* readAnswers(input.dir);
    if (answers.some((answered) => answered.decisionId === decision.id)) {
      return yield* failure("Esa decisión ya está contestada.");
    }
    const label = companyPanelAnswerLabel(decision, input.answer);
    if (label === null) return yield* failure("Esa opción ya no existe.");
    const threads: ThreadsFile | null = yield* readThreadsFile(input.dir);
    const informerThreadId = threads?.informadores[person]?.threadId;
    if (informerThreadId === undefined) {
      return yield* failure("No encuentro tu Informador para pasarle la respuesta.");
    }
    return {
      person,
      informerThreadId,
      text: companyPanelAnswerMessage(decision, label),
      record: Effect.gen(function* () {
        const answeredAt = DateTime.formatIso(yield* DateTime.now);
        const line = yield* encodeAnswerLine({
          decisionId: decision.id,
          title: decision.title,
          answer: label,
          person,
          answeredAt,
        });
        yield* fileSystem.writeFileString(path.join(input.dir, ANSWERS_FILE), `${line}\n`, {
          flag: "a",
        });
      }).pipe(Effect.mapError(() => failure("La respuesta salió, pero no se pudo apuntar."))),
    };
  });
