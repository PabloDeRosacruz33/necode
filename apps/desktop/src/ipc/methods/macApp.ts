// @effect-diagnostics nodeBuiltinImport:off -- This macOS boundary unzips and launches the user's built apps with Node.
/**
 * "Compilar y abrir app Mac" on the user's own Mac. A build from this machine opens in place; a
 * build from a remote environment arrives zipped in pieces, is unpacked into Necode's cache
 * (replacing the previous copy of that app) and opened. Every open quits the running copies of
 * the bundle first, so only the newest build is ever on screen.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { quitMacAppCommand } from "@t3tools/shared/macApp";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class MacAppIpcError extends Schema.TaggedError<MacAppIpcError>()("MacAppIpcError", {
  message: Schema.String,
}) {}

const INSTALL_ROOT = NodePath.join(NodeOS.homedir(), "Library", "Caches", "Necode", "mac-apps");
const SIMULATOR_APPS_ROOT = NodePath.join(
  NodeOS.homedir(),
  "Library",
  "Caches",
  "Necode",
  "simulator-apps",
);
/** Zips being received, by install id. */
const pendingInstalls = new Map<string, string>();

function exec(command: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { timeout: 120_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function execOutput(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

interface SimulatorDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
}

/** The booted iPhone simulator, or the newest iOS runtime's first iPhone, booted now. */
async function simulatorDevice(): Promise<SimulatorDevice> {
  const listed = JSON.parse(
    await execOutput("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ) as { devices: Record<string, ReadonlyArray<SimulatorDevice>> };
  const runtimes = Object.entries(listed.devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
  const devices = runtimes.flatMap(([, entries]) => entries);
  const booted =
    devices.find((device) => device.state === "Booted" && device.name.includes("iPhone")) ??
    devices.find((device) => device.state === "Booted");
  if (booted) return booted;
  const pick = devices.find((device) => device.name.includes("iPhone")) ?? devices[0];
  if (!pick) throw new Error("this Mac has no iOS simulator; install one in Xcode");
  await exec("/usr/bin/xcrun", ["simctl", "boot", pick.udid]);
  return pick;
}

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new MacAppIpcError({
        message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const ensureMainWindowSender = Effect.fn("desktop.ipc.macApp.ensureSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (event === undefined || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
    return yield* new MacAppIpcError({ message: "Request rejected." });
  }
});

async function quit(bundleId: string | null): Promise<void> {
  if (!bundleId) return;
  const { command, args } = quitMacAppCommand(bundleId);
  await exec(command, args).catch(() => undefined);
}

async function open(appPath: string, bundleId: string | null): Promise<void> {
  if (!appPath.endsWith(".app")) throw new Error(`${appPath} is not an app`);
  await NodeFSP.access(appPath);
  await quit(bundleId);
  await exec("/usr/bin/open", [appPath]);
}

export const openMacApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_MAC_APP_CHANNEL,
  payload: Schema.Struct({ appPath: Schema.String, bundleId: Schema.NullOr(Schema.String) }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.macApp.open")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    yield* attempt("Could not open the app", () => open(input.appPath, input.bundleId));
  }),
});

export const quitMacApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUIT_MAC_APP_CHANNEL,
  payload: Schema.Struct({ bundleId: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.macApp.quit")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    yield* attempt("Could not close the app", () => quit(input.bundleId));
  }),
});

export const beginMacAppInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BEGIN_MAC_APP_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.macApp.beginInstall")(function* (_input, event) {
    yield* ensureMainWindowSender(event);
    const id = NodeCrypto.randomUUID();
    const zipPath = NodePath.join(NodeOS.tmpdir(), `necode-mac-app-${id}.zip`);
    yield* attempt("Could not start the download", () => NodeFSP.writeFile(zipPath, ""));
    pendingInstalls.set(id, zipPath);
    return id;
  }),
});

export const appendMacAppInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPEND_MAC_APP_INSTALL_CHANNEL,
  payload: Schema.Struct({ id: Schema.String, data: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.macApp.appendInstall")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    const zipPath = pendingInstalls.get(input.id);
    if (!zipPath) return yield* new MacAppIpcError({ message: "Unknown download." });
    yield* attempt("Could not save the download", () =>
      NodeFSP.appendFile(zipPath, Buffer.from(input.data, "base64")),
    );
  }),
});

/** Unpacks the downloaded app over the previous copy of the same app, then opens it. */
export const finishMacAppInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FINISH_MAC_APP_INSTALL_CHANNEL,
  payload: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    bundleId: Schema.NullOr(Schema.String),
  }),
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.macApp.finishInstall")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    const zipPath = pendingInstalls.get(input.id);
    if (!zipPath) return yield* new MacAppIpcError({ message: "Unknown download." });
    pendingInstalls.delete(input.id);
    const slot = (input.bundleId ?? input.name).replace(/[^\w.-]+/g, "_");
    const staging = NodePath.join(INSTALL_ROOT, `.${slot}-${input.id}`);
    const target = NodePath.join(INSTALL_ROOT, slot);
    return yield* attempt("Could not install the app", async () => {
      try {
        await NodeFSP.mkdir(staging, { recursive: true });
        await exec("/usr/bin/ditto", ["-x", "-k", zipPath, staging]);
        const app = (await NodeFSP.readdir(staging)).find((entry) => entry.endsWith(".app"));
        if (!app) throw new Error("the download has no app inside");
        await quit(input.bundleId);
        await NodeFSP.rm(target, { recursive: true, force: true });
        await NodeFSP.rename(staging, target);
        const appPath = NodePath.join(target, app);
        await exec("/usr/bin/open", [appPath]);
        return appPath;
      } finally {
        await NodeFSP.rm(zipPath, { force: true });
        await NodeFSP.rm(staging, { recursive: true, force: true });
      }
    });
  }),
});

/**
 * Unpacks a simulator build downloaded from the environment and runs it on this Mac's own
 * simulator (booting one when none is), so the person tests with no network in between.
 * Returns the simulator's name.
 */
export const finishSimulatorAppInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FINISH_SIMULATOR_APP_INSTALL_CHANNEL,
  payload: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    bundleId: Schema.NullOr(Schema.String),
  }),
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.macApp.finishSimulatorInstall")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    const zipPath = pendingInstalls.get(input.id);
    if (!zipPath) return yield* new MacAppIpcError({ message: "Unknown download." });
    pendingInstalls.delete(input.id);
    const slot = (input.bundleId ?? input.name).replace(/[^\w.-]+/g, "_");
    const staging = NodePath.join(SIMULATOR_APPS_ROOT, `.${slot}-${input.id}`);
    const target = NodePath.join(SIMULATOR_APPS_ROOT, slot);
    return yield* attempt("Could not run the app in the simulator", async () => {
      try {
        await NodeFSP.mkdir(staging, { recursive: true });
        await exec("/usr/bin/ditto", ["-x", "-k", zipPath, staging]);
        const app = (await NodeFSP.readdir(staging)).find((entry) => entry.endsWith(".app"));
        if (!app) throw new Error("the download has no app inside");
        await NodeFSP.rm(target, { recursive: true, force: true });
        await NodeFSP.rename(staging, target);
        const appPath = NodePath.join(target, app);
        const bundleId =
          input.bundleId ??
          (
            await execOutput("/usr/libexec/PlistBuddy", [
              "-c",
              "Print CFBundleIdentifier",
              NodePath.join(appPath, "Info.plist"),
            ])
          ).trim();
        const device = await simulatorDevice();
        await exec("/usr/bin/open", [
          "-a",
          "Simulator",
          "--args",
          "-CurrentDeviceUDID",
          device.udid,
        ]);
        await exec("/usr/bin/xcrun", ["simctl", "terminate", device.udid, bundleId]).catch(
          () => undefined,
        );
        await exec("/usr/bin/xcrun", ["simctl", "install", device.udid, appPath]);
        await exec("/usr/bin/xcrun", ["simctl", "launch", device.udid, bundleId]);
        return device.name;
      } finally {
        await NodeFSP.rm(zipPath, { force: true });
        await NodeFSP.rm(staging, { recursive: true, force: true });
      }
    });
  }),
});
