/** Lets a remote environment use this Mac's simulators; see deviceHost/clientDeviceHost.ts. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ClientDeviceHost from "../../deviceHost/clientDeviceHost.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class ClientDeviceHostIpcError extends Schema.TaggedError<ClientDeviceHostIpcError>()(
  "ClientDeviceHostIpcError",
  { message: Schema.String },
) {}

const ExecResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.Int,
});

const ensureMainWindowSender = Effect.fn("desktop.ipc.clientDeviceHost.ensureSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (event === undefined || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
    return yield* new ClientDeviceHostIpcError({ message: "Request rejected." });
  }
});

export const deviceHostExec = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DEVICE_HOST_EXEC_CHANNEL,
  payload: Schema.Struct({
    command: Schema.String,
    args: Schema.Array(Schema.String),
    stdin: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
  result: ExecResult,
  handler: Effect.fn("desktop.ipc.clientDeviceHost.exec")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    return yield* Effect.promise(() => ClientDeviceHost.exec(input));
  }),
});

export const deviceHostInstallTools = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DEVICE_HOST_INSTALL_TOOLS_CHANNEL,
  payload: Schema.Struct({
    toolsUrl: Schema.String,
    query: Schema.Record(Schema.String, Schema.String),
    tools: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String })),
  }),
  result: ExecResult,
  handler: Effect.fn("desktop.ipc.clientDeviceHost.installTools")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    return yield* Effect.promise(() => ClientDeviceHost.installTools(input));
  }),
});

export const deviceHostOpenTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DEVICE_HOST_OPEN_TUNNEL_CHANNEL,
  payload: Schema.Struct({ url: Schema.String, port: Schema.Int }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientDeviceHost.openTunnel")(function* (input, event) {
    yield* ensureMainWindowSender(event);
    ClientDeviceHost.openTunnel(input);
  }),
});
