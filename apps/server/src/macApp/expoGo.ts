// @effect-diagnostics nodeBuiltinImport:off -- one JSON file read outside any Effect service.
// @effect-diagnostics globalFetch:off -- one cached read of Expo's public version list.
/**
 * The Expo Go build for the simulator that runs an Expo app, so «Simular → Expo Go en este Mac»
 * can install it when the simulator lacks it.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

let expoVersions: Promise<Record<string, { readonly iosClientUrl?: string }>> | null = null;

/**
 * The build Expo publishes for the SDK installed in `appDir` (api.expo.dev/v2/versions, read
 * once per server). Null when it cannot be known.
 */
export async function expoGoSimulatorUrl(appDir: string): Promise<string | null> {
  const manifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(appDir, "node_modules", "expo", "package.json"), "utf8"),
  ) as { version?: string };
  const major = manifest.version?.split(".")[0];
  if (!major) return null;
  expoVersions ??= fetch("https://api.expo.dev/v2/versions")
    .then(
      (response) =>
        response.json() as Promise<{ data?: { sdkVersions?: object }; sdkVersions?: object }>,
    )
    .then(
      (body) =>
        ((body.data ?? body).sdkVersions ?? {}) as Record<
          string,
          { readonly iosClientUrl?: string }
        >,
    )
    .catch((error: unknown) => {
      // A failed read is tried again next time.
      expoVersions = null;
      throw error;
    });
  return (await expoVersions)[`${major}.0.0`]?.iosClientUrl ?? null;
}
