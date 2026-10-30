/**
 * Necode: when a provider account (a provider instance, e.g. one of the team's Claude plans) hits
 * its usage limit, work moves to another account of the same provider that serves the same model
 * and still has room, so conversations keep going without anyone switching accounts by hand.
 *
 * An account counts as limited while a run on it failed with a usage limit that has not reset, or
 * while one of its usage windows reports 100% until a future reset.
 */
import type { ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export function providerLimitedUntil(
  provider: ServerProvider,
  reportedResets: ReadonlyMap<string, number>,
  nowMs: number,
): number | null {
  const resets = [reportedResets.get(provider.instanceId) ?? 0];
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent >= 100 && window.resetsAt !== undefined) {
      resets.push(Date.parse(window.resetsAt));
    }
  }
  const until = Math.max(...resets.filter(Number.isFinite));
  return until > nowMs ? until : null;
}

/** Highest share used across the account's windows; accounts that report none count as empty. */
const usedPercent = (provider: ServerProvider) =>
  Math.max(0, ...(provider.usageLimits?.windows ?? []).map((window) => window.usedPercent));

/**
 * The account `selection` should move to, or null when its own account is not limited or no
 * other account of the same provider can serve the model. Prefers the account with most room.
 */
export function pickFailoverProvider(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly reportedResets: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly enabledForProject: (provider: ServerProvider) => boolean;
}): ServerProvider | null {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  if (
    source === undefined ||
    providerLimitedUntil(source, input.reportedResets, input.nowMs) === null
  ) {
    return null;
  }
  const candidates = input.providers.filter(
    (provider) =>
      provider.instanceId !== source.instanceId &&
      provider.driver === source.driver &&
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.auth.status !== "unauthenticated" &&
      provider.models.some((model) => model.slug === input.selection.model) &&
      providerLimitedUntil(provider, input.reportedResets, input.nowMs) === null &&
      input.enabledForProject(provider),
  );
  return candidates.toSorted((left, right) => usedPercent(left) - usedPercent(right))[0] ?? null;
}

export interface FailoverRoute {
  readonly selection: ModelSelection;
  readonly from: ServerProvider;
  readonly to: ServerProvider;
}

export class ProviderAccountFailover extends Context.Service<
  ProviderAccountFailover,
  {
    /** Records a usage limit a run hit, so later work avoids that account until `resetAt`. */
    readonly reportLimit: (instanceId: string, resetAt: string) => Effect.Effect<void>;
    /** Where work for `selection` should run now, or null to keep it on its own account. */
    readonly route: (input: {
      readonly selection: ModelSelection;
      readonly projectId: ProjectId;
    }) => Effect.Effect<FailoverRoute | null>;
  }
>()("t3/orchestration-v2/ProviderAccountFailover") {}

export const providerLabel = (provider: ServerProvider) =>
  provider.displayName ?? provider.auth.email ?? provider.instanceId;

export const layer = Layer.effect(
  ProviderAccountFailover,
  Effect.gen(function* () {
    // Absent in runtimes without provider snapshots (some tests); routing is then off.
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const reportedResets = yield* Ref.make(new Map<string, number>());

    return ProviderAccountFailover.of({
      reportLimit: (instanceId, resetAt) =>
        Ref.update(reportedResets, (current) => {
          const resetMs = Date.parse(resetAt);
          if (!Number.isFinite(resetMs) || resetMs <= (current.get(instanceId) ?? 0)) {
            return current;
          }
          return new Map(current).set(instanceId, resetMs);
        }),
      route: ({ selection, projectId }) =>
        Effect.gen(function* () {
          if (providerRegistry._tag === "None") return null;
          const providers = yield* providerRegistry.value.getProviders;
          const settings = yield* serverSettings.getSettings;
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const to = pickFailoverProvider({
            providers,
            selection,
            reportedResets: yield* Ref.get(reportedResets),
            nowMs,
            // The registry already reflects machine settings; a project can still turn one off.
            enabledForProject: (provider) =>
              settings.projectSettingsOverrides[projectId]?.providerInstances?.[provider.instanceId]
                ?.enabled ?? true,
          });
          const from = providers.find((provider) => provider.instanceId === selection.instanceId);
          if (to === null || from === undefined) return null;
          return { selection: { ...selection, instanceId: to.instanceId }, from, to };
        }).pipe(
          // Routing is a best effort: if settings cannot be read, work stays where it was sent.
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    });
  }),
);
