/**
 * Many TCP connections over one WebSocket, the way SSH carries its forwards: opening a
 * connection costs one frame instead of a new handshake, which matters on slow links (a plane's
 * wifi). Every binary frame is `[kind: u8][stream: u32 BE][payload]`: `open` carries the port to
 * connect to (u16 BE), `data` carries bytes, `close` nothing.
 */
export type MuxFrame =
  | { readonly kind: "open"; readonly stream: number; readonly port: number }
  | { readonly kind: "data"; readonly stream: number; readonly bytes: Uint8Array }
  | { readonly kind: "close"; readonly stream: number };

const KINDS = { open: 1, data: 2, close: 3 } as const;

export function encodeMuxFrame(frame: MuxFrame): Uint8Array<ArrayBuffer> {
  const payload =
    frame.kind === "open"
      ? new Uint8Array([frame.port >> 8, frame.port & 0xff])
      : frame.kind === "data"
        ? frame.bytes
        : new Uint8Array(0);
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, KINDS[frame.kind]);
  view.setUint32(1, frame.stream);
  out.set(payload, 5);
  return out;
}

/** Null for a frame this protocol does not know, which callers drop. */
export function decodeMuxFrame(bytes: Uint8Array): MuxFrame | null {
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stream = view.getUint32(1);
  switch (view.getUint8(0)) {
    case KINDS.open:
      return bytes.length < 7 ? null : { kind: "open", stream, port: view.getUint16(5) };
    case KINDS.data:
      return { kind: "data", stream, bytes: bytes.subarray(5) };
    case KINDS.close:
      return { kind: "close", stream };
    default:
      return null;
  }
}

/** A connection the client side opens for a stream: a Node socket satisfies it. */
export interface MuxSocket {
  write(bytes: Uint8Array): unknown;
  destroy(): unknown;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

/**
 * The client side of a link: for every stream the other side opens, `connect` makes the
 * connection to that port here, and bytes flow both ways until either side closes it.
 */
export function serveMuxLink(ws: WebSocket, connect: (port: number) => MuxSocket): void {
  ws.binaryType = "arraybuffer";
  const streams = new Map<number, MuxSocket>();
  const send = (frame: MuxFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMuxFrame(frame));
  };
  ws.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = decodeMuxFrame(new Uint8Array(event.data));
    if (!frame) return;
    if (frame.kind === "open") {
      const socket = connect(frame.port);
      streams.set(frame.stream, socket);
      socket.on("data", (chunk) =>
        send({ kind: "data", stream: frame.stream, bytes: new Uint8Array(chunk) }),
      );
      const close = () => {
        if (streams.delete(frame.stream)) send({ kind: "close", stream: frame.stream });
      };
      socket.on("close", close);
      socket.on("error", close);
    } else if (frame.kind === "data") {
      streams.get(frame.stream)?.write(frame.bytes);
    } else {
      streams.get(frame.stream)?.destroy();
      streams.delete(frame.stream);
    }
  });
  const closeAll = () => {
    for (const socket of streams.values()) socket.destroy();
    streams.clear();
  };
  ws.addEventListener("close", closeAll);
  ws.addEventListener("error", closeAll);
}
