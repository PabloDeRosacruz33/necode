import { assert, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAccountFailover from "./ProviderAccountFailover.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const claude = (instanceId: string, displayName: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T11:59:00.000Z",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
});

it.effect("continues a limited thread on the other account of the same provider", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const limitedRun: ProjectionStore.ProjectionUsageLimitedRun = {
      threadId: ThreadId.make("thread:limited"),
      projectId: ProjectId.make("project:test"),
      runId: RunId.make("run:limited"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      resetAt: DateTime.formatIso(DateTime.add(now, { hours: 5 })),
    };
    const limited = yield* Ref.make<ReadonlyArray<ProjectionStore.ProjectionUsageLimitedRun>>([
      limitedRun,
    ]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const layerFailover = ProviderAccountFailover.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ProviderRegistryMock.layer([
            claude("claudeAgent", "Plan Pablo"),
            claude("claudeAgent_roi", "Plan Roi"),
          ]),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
        ),
      ),
    );
    const layerWorker = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerFailover,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitedRuns: () => Ref.get(limited),
            getLimitRecoveryCandidates: () => Effect.succeed([]),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: (command) =>
              Ref.update(commands, (all) => [...all, command]).pipe(
                // The continuation becomes the thread's latest run.
                Effect.andThen(Ref.set(limited, [])),
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
        ),
      ),
      Layer.provide(Scheduler.layer),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      const delivered = yield* Ref.get(commands);
      assert.equal(delivered.length, 2);
      expect(delivered[0]).toMatchObject({
        type: "message.dispatch",
        threadId: limitedRun.threadId,
        manualContinuationOfRunId: limitedRun.runId,
        modelSelection: { ...limitedRun.modelSelection, instanceId: "claudeAgent_roi" },
        dispatchMode: { type: "start_immediately" },
      });
      expect(delivered[0]).toHaveProperty(
        "text",
        expect.stringContaining("«Plan Pablo» ha llegado a su límite"),
      );
      expect(delivered[1]).toMatchObject({ type: "queue.resume", threadId: limitedRun.threadId });

      // Work later sent to the limited account goes to the free one.
      const failover = yield* ProviderAccountFailover.ProviderAccountFailover;
      const route = yield* failover.route({
        selection: limitedRun.modelSelection,
        projectId: limitedRun.projectId,
      });
      assert.equal(route?.selection.instanceId, "claudeAgent_roi");
    }).pipe(Effect.provide(Layer.merge(layerWorker, layerFailover)));
  }),
);
