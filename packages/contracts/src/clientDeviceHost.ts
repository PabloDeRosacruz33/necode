import * as Schema from "effect/Schema";

/**
 * A desktop app offering its own Mac's simulators to a remote environment. The environment asks
 * it to run simulator commands, to receive the device tools, and to open a tunnel to one of its
 * loopback ports (opened as `/api/client-device-host/tunnel/<tunnelId>`).
 */
export const ClientDeviceHostRequest = Schema.Union([
  Schema.TaggedStruct("exec", {
    requestId: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    stdin: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
  /** Fetch these tools from `/api/client-device-host/tools/<name>` unless already installed. */
  Schema.TaggedStruct("installTools", {
    requestId: Schema.String,
    tools: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String })),
  }),
  Schema.TaggedStruct("tunnel", { tunnelId: Schema.String, port: Schema.Int }),
]);
export type ClientDeviceHostRequest = typeof ClientDeviceHostRequest.Type;

export const ClientDeviceHostConnectInput = Schema.Struct({});
export type ClientDeviceHostConnectInput = typeof ClientDeviceHostConnectInput.Type;

/** The outcome of an `exec` or `installTools` request; `code` 0 is success. */
export const ClientDeviceHostResponse = Schema.Struct({
  requestId: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.Int,
});
export type ClientDeviceHostResponse = typeof ClientDeviceHostResponse.Type;
