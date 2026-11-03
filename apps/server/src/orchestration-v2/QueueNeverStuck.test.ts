import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "queue-never-stuck" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:queue"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const fromPerson = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const fromThread = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      senderThreadId: ThreadId.make("thread:other"),
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

const fromSchedule = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      scheduledTaskId: ScheduledTaskId.make("scheduled-task:clock"),
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

/** Each message, in order sent, with where it stands. */
const standing = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return [...projection.runs]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((run) => {
        const text = projection.messages.find((message) => message.id === run.userMessageId)?.text;
        return `${text}: ${run.status}${run.queueHeld === true ? " held" : ""}`;
      });
  });

const stop = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`stop:${threadId}`),
      threadId,
    });
  });

it.effect("a stop does not hold a queue with a scheduled message, which nobody would release", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:queue-clock");
    yield* createThread(threadId);
    yield* fromPerson(threadId, "active");
    yield* fromSchedule(threadId, "clock");
    yield* stop(threadId);
    const after = yield* standing(threadId);
    assert.isFalse(
      after.some((line) => line.endsWith(" held")),
      after.join(" | "),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a message never becomes held because of what is already held", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:queue-contagion");
    yield* createThread(threadId);
    yield* fromPerson(threadId, "active");
    yield* fromPerson(threadId, "follow-up");
    yield* stop(threadId);
    assert.include(yield* standing(threadId), "follow-up: queued held");
    yield* fromThread(threadId, "from another thread");
    const after = yield* standing(threadId);
    assert.isFalse(
      after.some((line) => line.endsWith(" held")),
      after.join(" | "),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a new message on a free thread does not overtake what is waiting", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:queue-order");
    yield* createThread(threadId);
    yield* fromPerson(threadId, "active");
    yield* fromPerson(threadId, "first");
    yield* fromPerson(threadId, "second");
    yield* stop(threadId);
    yield* fromThread(threadId, "third");
    const after = yield* standing(threadId);
    const stateOf = (text: string) =>
      after.find((line) => line.startsWith(`${text}: `))?.slice(text.length + 2);
    assert.notEqual(stateOf("first"), "queued", after.join(" | "));
    assert.equal(stateOf("second"), "queued", after.join(" | "));
    assert.equal(stateOf("third"), "queued", after.join(" | "));
  }).pipe(Effect.provide(layerTest)),
);
