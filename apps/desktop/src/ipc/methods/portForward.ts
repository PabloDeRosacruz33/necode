/** Keeps the remote environments' dev servers answering on this Mac's localhost. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { syncPortForwards as sync } from "../../portForward/portForwards.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class PortForwardIpcError extends Schema.TaggedError<PortForwardIpcError>()("PortForwardIpcError", {
  message: Schema.String,
}) {}

export const syncPortForwards = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SYNC_PORT_FORWARDS_CHANNEL,
  payload: Schema.Struct({
    forwards: Schema.Array(Schema.Struct({ port: Schema.Int, url: Schema.String })),
  }),
  result: Schema.Array(Schema.Struct({ port: Schema.Int, forwarding: Schema.Boolean })),
  handler: Effect.fn("desktop.ipc.portForward.sync")(function* (input, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new PortForwardIpcError({ message: "Request rejected." });
    }
    return yield* Effect.promise(() => sync(input.forwards));
  }),
});
