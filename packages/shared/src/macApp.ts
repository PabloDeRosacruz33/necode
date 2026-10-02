/**
 * Pieces of "Compilar y abrir app Mac" shared by the server (which builds, and opens when the
 * client cannot) and the desktop app (which opens on the user's own Mac).
 */

/** The last absolute `.app` path a build printed, e.g. "Resultado: /tmp/x/Necora Staging.app". */
export function findBuiltAppPath(output: string): string | null {
  let found: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /(\/[^\n]*?\.app)\/?\s*$/.exec(line);
    if (match) found = match[1]!;
  }
  return found;
}

/**
 * JavaScript for Automation that quits every running copy of a bundle id (argv[0]), forcing the
 * ones still open after five seconds, so only the newest build ever runs.
 */
export const QUIT_MAC_APP_SCRIPT = `
ObjC.import("AppKit");
function running(id) { return $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id); }
function run(argv) {
  const id = argv[0];
  const apps = running(id);
  for (let i = 0; i < apps.count; i++) apps.objectAtIndex(i).terminate;
  for (let t = 0; t < 50 && running(id).count > 0; t++) delay(0.1);
  const left = running(id);
  for (let i = 0; i < left.count; i++) left.objectAtIndex(i).forceTerminate;
  return String(apps.count);
}`;

export function quitMacAppCommand(bundleId: string): { command: string; args: string[] } {
  return { command: "osascript", args: ["-l", "JavaScript", "-e", QUIT_MAC_APP_SCRIPT, bundleId] };
}

/** Reads CFBundleIdentifier from a built app. */
export function readBundleIdCommand(appPath: string): { command: string; args: string[] } {
  return {
    command: "/usr/libexec/PlistBuddy",
    args: ["-c", "Print :CFBundleIdentifier", `${appPath}/Contents/Info.plist`],
  };
}
