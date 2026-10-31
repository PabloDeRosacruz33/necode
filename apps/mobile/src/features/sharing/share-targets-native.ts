import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { Platform } from "react-native";

import type { PinnedShareTarget } from "./share-targets";

interface ShareTargetsModule {
  setPinnedThreads(appGroupId: string, json: string): Promise<void>;
  takeShareTarget(appGroupId: string): string | null;
}

// The share extension's App Group (see sharingPlugin in app.config.ts). iOS only; personal-team
// builds have no extension, so the module is simply unused there.
const appGroupId = (() => {
  const bundleIdentifier = Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  return Platform.OS === "ios" && bundleIdentifier ? `group.${bundleIdentifier}` : null;
})();

const nativeModule =
  appGroupId === null ? null : requireOptionalNativeModule<ShareTargetsModule>("T3ShareTargets");

export function publishPinnedShareTargets(targets: ReadonlyArray<PinnedShareTarget>): void {
  if (nativeModule === null || appGroupId === null) return;
  nativeModule.setPinnedThreads(appGroupId, JSON.stringify(targets)).catch((error: unknown) => {
    console.warn("[share-targets] could not publish pinned threads", error);
  });
}

/** The thread picked in the share extension, as JSON; reading it removes it. */
export function takePickedShareTarget(): string | null {
  if (nativeModule === null || appGroupId === null) return null;
  return nativeModule.takeShareTarget(appGroupId);
}
