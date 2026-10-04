import * as Schema from "effect/Schema";

/**
 * A web page an agent, terminal or script opened on the server, to be opened on the device the
 * person is working from. The device confirms with `openUrl.ack` once it has opened it.
 */
export const OpenUrlRequest = Schema.Struct({
  requestId: Schema.String,
  url: Schema.String,
});
export type OpenUrlRequest = typeof OpenUrlRequest.Type;

export const OpenUrlConnectInput = Schema.Struct({});
export type OpenUrlConnectInput = typeof OpenUrlConnectInput.Type;

export const OpenUrlAckInput = Schema.Struct({ requestId: Schema.String });
export type OpenUrlAckInput = typeof OpenUrlAckInput.Type;
