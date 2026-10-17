import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<ServerSettings, "sidebarAutoSettleOnMerge">;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
  },
  targets: readonly AutoSettleSyncTarget[],
) {
  const patch: AutoSettleSettings = {
    sidebarAutoSettleOnMerge: reference.settings.sidebarAutoSettleOnMerge,
  };
  const mismatches = targets.filter(
    (target) =>
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      target.settings !== null &&
      target.settings.sidebarAutoSettleOnMerge !== patch.sidebarAutoSettleOnMerge,
  );
  return { patch, mismatches };
}
